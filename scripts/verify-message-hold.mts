/**
 * Held SMS campaigns: the five-minute hold, Cancel, and the release that sends.
 *
 * A text cannot be recalled once the gateway has it, so "unsend" is only possible by not having sent YET.
 * This proves the three things that make that true:
 *   - a held campaign sends NOTHING until released (no message leaves while it is SCHEDULED),
 *   - Cancel and release cannot both win (they race on one conditional update; exactly one commits),
 *   - the net under a closed tab (the scheduled endpoint) sends a due campaign once and refuses a stranger.
 *
 * The first half is pure and reads source with comments stripped (this codebase explains its mistakes at length, and
 * the words would satisfy a search). The second half writes real rows for the demo school inside a try/finally that
 * restores its SMS settings and removes everything it made, and sends nothing: SMS_DRY_RUN is forced on.
 *
 * Run: npm run verify:message-hold
 */
process.env.SMS_DRY_RUN = "1";

import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant-context";
import { demoSchool, withOwner } from "./fixture.mjs";
import { HOLD_MINUTES, HOLD_MS, countdownLabel, isDue, msUntil, releaseAt } from "@/lib/message-hold";
import { cancelHeldCampaign, releaseDueCampaigns, releaseHeldCampaign } from "@/lib/message-dispatch";
import { POST as cronPost } from "../src/app/api/cron/messages/route";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("The hold");
const t0 = new Date("2026-10-22T10:00:00Z");
check("five minutes, the school's choice", HOLD_MINUTES === 5 && HOLD_MS === 300_000);
check("a campaign pressed now is released five minutes later", releaseAt(t0).getTime() - t0.getTime() === 300_000);
check("time left is never negative", msUntil(new Date(t0.getTime() - 1000), t0) === 0 && msUntil(releaseAt(t0), t0) === 300_000);
check("due exactly at the moment, not a second before", isDue(releaseAt(t0), releaseAt(t0)) && !isDue(releaseAt(t0), new Date(releaseAt(t0).getTime() - 1)));
check("no time set is never due", !isDue(null, t0) && !isDue(undefined, t0));
check("the countdown reads m:ss", countdownLabel(300_000) === "5:00" && countdownLabel(61_000) === "1:01" && countdownLabel(500) === "0:01");

console.log("\nThe code");
const actions = code("src/lib/message-actions.ts");
const send = actions.slice(actions.indexOf("export async function sendCampaign"), actions.indexOf("export type HoldState"));
const dispatch = code("src/lib/message-dispatch.ts");
const route = code("src/app/api/cron/messages/route.ts");
check("a held send saves the campaign as SCHEDULED with a release time", /hold \? "SCHEDULED" : "SENDING"/.test(send) && /releaseAt\(/.test(send));
check("and does NOT dispatch: the only dispatch in sendCampaign is behind !hold", /if \(!hold\) \{\s*await dispatchQueued\(/.test(send) && (send.match(/dispatchQueued\(/g) ?? []).length === 1);
check("a held send is audited as 'schedule', not as a send", /if \(hold\) \{\s*await writeAudit\([\s\S]*?action: "campaign\.schedule"[\s\S]*?\} else \{\s*await writeAudit\([\s\S]*?action: "campaign\.send"/.test(send));
check("a cancelled campaign neither blocks a resend as a duplicate nor eats the daily cap", (send.match(/status: \{ not: "CANCELLED" \}/g) ?? []).length === 2);
check("Cancel updates conditionally on SCHEDULED (the half of the race it must win or lose cleanly)", /updateMany\(\{\s*where: \{ id: campaignId, status: "SCHEDULED" \}/.test(dispatch));
check("release claims conditionally on SCHEDULED and due", /status: "SCHEDULED", scheduledAt: \{ lte: now \}/.test(dispatch));
check("release re-reads the school's SMS switch at release time", /smsEnabled/.test(dispatch.slice(dispatch.indexOf("export async function releaseHeldCampaign"))));
check("cancelled messages cost nothing", /cost: new Prisma\.Decimal\(0\)/.test(dispatch) && /status: "CANCELLED"/.test(dispatch));
check("the actions are role-checked and tenant-scoped", /export async function cancelCampaign[\s\S]*?requireRole\(OFFICE\)[\s\S]*?setTenantContext/.test(actions) && /export async function releaseCampaignNow[\s\S]*?requireRole\(OFFICE\)[\s\S]*?setTenantContext/.test(actions));
check("every export of the actions module is an async function or a type ('use server')", [...actions.matchAll(/^export (?!async function|type)/gm)].length === 0);
check("the dispatch module is not a 'use server' file (its exports take a school id)", !/^"use server"/m.test(readFileSync("src/lib/message-dispatch.ts", "utf8")));
check("the endpoint fails closed with no secret, and checks it BEFORE any work", route.indexOf("CRON_SECRET") < route.indexOf("releaseDueCampaigns(") && /status: 503/.test(route) && /status: 401/.test(route));
check("the endpoint compares in constant time", /timingSafeEqual/.test(route));
check("the endpoint has no query of its own", !/prisma\./.test(route));
check("the scheduled job calls it, and skips rather than fails when unset", /release-scheduled-messages/.test(readFileSync(".github/workflows/release-scheduled-messages.yml", "utf8")) && /not set - skipping/.test(readFileSync(".github/workflows/release-scheduled-messages.yml", "utf8")));

console.log("\nThe database");
const school = await demoSchool();
const ctx = { schoolId: school.id, readOnly: false };
const made: string[] = [];
let saved: { smsEnabled: boolean; smsProvider: string | null } | null = null;

async function held(opts: { due: boolean; messages?: number }) {
  return withOwner(async (owner) => {
    const campaign = await owner.messageCampaign.create({
      data: {
        schoolId: school.id,
        name: "verify-hold",
        body: "verify hold",
        audienceType: "CUSTOM",
        status: "SCHEDULED",
        scheduledAt: new Date(Date.now() + (opts.due ? -60_000 : 600_000)),
        totalRecipients: opts.messages ?? 2,
      },
    });
    await owner.message.createMany({
      data: Array.from({ length: opts.messages ?? 2 }, (_, i) => ({
        schoolId: school.id,
        campaignId: campaign.id,
        channel: "SMS" as const,
        toPhone: `23354000000${i}`,
        body: "verify hold",
        status: "QUEUED" as const,
        segments: 1,
        cost: new Prisma.Decimal("0.035"),
        provider: "ARKESEL" as const,
      })),
    });
    made.push(campaign.id);
    return campaign.id;
  });
}
const state = (id: string) =>
  withOwner(async (owner) => ({
    campaign: (await owner.messageCampaign.findUniqueOrThrow({ where: { id } })).status,
    statuses: (await owner.message.findMany({ where: { campaignId: id }, select: { status: true, cost: true } })).map((m) => m.status),
    costs: (await owner.message.findMany({ where: { campaignId: id }, select: { cost: true } })).reduce((sum, m) => sum + Number(m.cost ?? 0), 0),
  }));
const inSchool = <T,>(fn: () => Promise<T>) => runWithTenantContext(ctx, fn);

try {
  saved = await withOwner(async (owner) => {
    const row = await owner.schoolSettings.findUnique({ where: { schoolId: school.id } });
    await owner.schoolSettings.upsert({
      where: { schoolId: school.id },
      create: { schoolId: school.id, smsEnabled: true, smsProvider: "ARKESEL" },
      update: { smsEnabled: true, smsProvider: "ARKESEL" },
    });
    return row ? { smsEnabled: row.smsEnabled, smsProvider: row.smsProvider } : { smsEnabled: false, smsProvider: null };
  });

  // 1. Early: nothing leaves.
  const early = await held({ due: false });
  const rEarly = await inSchool(() => releaseHeldCampaign(school.id, early, null));
  const sEarly = await state(early);
  check("released before its time: answers 'early' with how long to wait", rEarly.state === "early" && rEarly.waitMs > 0);
  check("and nothing was sent: still SCHEDULED, every message still QUEUED", sEarly.campaign === "SCHEDULED" && sEarly.statuses.every((s) => s === "QUEUED"));

  // 2. Due: sends once.
  const due = await held({ due: true });
  const rDue = await inSchool(() => releaseHeldCampaign(school.id, due, null));
  const sDue = await state(due);
  check("released when due: sent", rDue.state === "sent" && sDue.campaign === "SENT" && sDue.statuses.every((s) => s === "SENT"));
  const again = await inSchool(() => releaseHeldCampaign(school.id, due, null));
  check("released a second time (another tab, or the job): 'gone', and nothing is sent twice", again.state === "gone");
  const lateCancel = await inSchool(() => cancelHeldCampaign(school.id, due, "late", null));
  check("Cancel after it sent is refused and changes nothing (a text cannot be taken back)", lateCancel === false && (await state(due)).campaign === "SENT");

  // 3. Cancel: nobody is texted, nothing is charged, and it cannot then be released.
  const toCancel = await held({ due: false });
  const cancelled = await inSchool(() => cancelHeldCampaign(school.id, toCancel, "Cancelled before sending", null));
  const sCancel = await state(toCancel);
  check("cancelled while held", cancelled === true && sCancel.campaign === "CANCELLED");
  check("every message is CANCELLED and costs nothing", sCancel.statuses.every((s) => s === "CANCELLED") && sCancel.costs === 0);
  check("cancelling twice is refused the second time", (await inSchool(() => cancelHeldCampaign(school.id, toCancel, "again", null))) === false);
  await withOwner((owner) => owner.messageCampaign.update({ where: { id: toCancel }, data: { scheduledAt: new Date(Date.now() - 1000) } }));
  const afterCancel = await inSchool(() => releaseHeldCampaign(school.id, toCancel, null));
  check("a cancelled campaign cannot be released, even once its time passes", afterCancel.state === "gone" && (await state(toCancel)).statuses.every((s) => s === "CANCELLED"));

  // 4. School switched SMS off during the hold: off means off.
  const offId = await held({ due: true });
  await withOwner((owner) => owner.schoolSettings.update({ where: { schoolId: school.id }, data: { smsEnabled: false } }));
  const rOff = await inSchool(() => releaseHeldCampaign(school.id, offId, null));
  const sOff = await state(offId);
  check("SMS switched off during the hold: cancelled with a reason, nothing sent", rOff.state === "cancelled" && sOff.campaign === "CANCELLED" && sOff.statuses.every((s) => s === "CANCELLED"));
  await withOwner((owner) => owner.schoolSettings.update({ where: { schoolId: school.id }, data: { smsEnabled: true } }));

  // 5. The race: Cancel and release at the same instant. Exactly one may win, five times over.
  let racesOk = 0;
  for (let i = 0; i < 5; i += 1) {
    const id = await held({ due: true, messages: 3 });
    const [released, cancelledNow] = await Promise.all([
      inSchool(() => releaseHeldCampaign(school.id, id, null)),
      inSchool(() => cancelHeldCampaign(school.id, id, "race", null)),
    ]);
    const s = await state(id);
    const releaseWon = released.state === "sent" && cancelledNow === false && s.campaign === "SENT" && s.statuses.every((x) => x === "SENT");
    const cancelWon = released.state === "gone" && cancelledNow === true && s.campaign === "CANCELLED" && s.statuses.every((x) => x === "CANCELLED");
    if (releaseWon || cancelWon) racesOk += 1;
    else console.log("    race result:", released.state, cancelledNow, s);
  }
  check("Cancel and release raced five times: each time exactly one won, and the other changed nothing", racesOk === 5);

  // 6. The scheduled endpoint.
  const stranger = await cronPost(new Request("http://x/api/cron/messages", { method: "POST" }));
  const savedSecret = process.env.CRON_SECRET;
  delete process.env.CRON_SECRET;
  const unconfigured = await cronPost(new Request("http://x/api/cron/messages", { method: "POST", headers: { authorization: "Bearer anything" } }));
  process.env.CRON_SECRET = "verify-secret-value";
  const wrong = await cronPost(new Request("http://x/api/cron/messages", { method: "POST", headers: { authorization: "Bearer not-it" } }));
  check("no secret configured: refused (503), not accepted", unconfigured.status === 503);
  check("no credentials: refused (401)", stranger.status === 503 || stranger.status === 401);
  check("a wrong secret: refused (401)", wrong.status === 401);
  const dueForJob = await held({ due: true });
  const futureForJob = await held({ due: false });
  const right = await cronPost(new Request("http://x/api/cron/messages", { method: "POST", headers: { authorization: "Bearer verify-secret-value" } }));
  const body = (await right.json()) as { due: number; sent: number };
  check("the right secret: 200, and the due campaign is sent", right.status === 200 && body.sent >= 1 && (await state(dueForJob)).campaign === "SENT");
  check("a campaign whose time has not come is left held", (await state(futureForJob)).campaign === "SCHEDULED");
  const second = await inSchool(() => releaseDueCampaigns());
  check("running the job again sends nothing twice", second.sent === 0);
  if (savedSecret === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = savedSecret;
} finally {
  await withOwner(async (owner) => {
    if (saved) {
      await owner.schoolSettings.update({ where: { schoolId: school.id }, data: { smsEnabled: saved.smsEnabled, smsProvider: saved.smsProvider as "ARKESEL" | null } });
    }
    // Messages and campaigns are ordinary rows; the AuditLog is append-only for the app role, so the owner removes it.
    await owner.message.deleteMany({ where: { campaignId: { in: made } } });
    await owner.auditLog.deleteMany({ where: { entityId: { in: made }, entity: "MessageCampaign" } });
    await owner.messageCampaign.deleteMany({ where: { id: { in: made } } });
  });
  await prisma.$disconnect();
}

console.log(failures === 0 ? "\nAll good." : `\n${failures} failed.`);
process.exit(failures === 0 ? 0 : 1);
