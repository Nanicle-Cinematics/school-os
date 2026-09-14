/**
 * The subscription is a switch that DOES something.
 *
 * `plan`, `subscriptionStatus`, `trialEndsAt` and `studentCap` were written at
 * provisioning, shown in the console and enforced nowhere, so a trial that ended
 * in March still worked in September. This proves the enforcement, and every
 * check here is a refusal or a lift — the two directions that matter.
 *
 *   npm run verify:platform   (no dev server needed)
 */
import { prisma, tenantTransaction, SchoolReadOnlyError } from "@/lib/prisma";
import { runWithTenantContext, setTenantContext, withBypass } from "@/lib/tenant-context";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  subscriptionState,
  nextDueDate,
  PLANS,
  TRIAL_DAYS,
  capacity,
  capacityMessage,
  pupilCap,
} from "@/lib/subscription";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
}

const DAY = 86_400_000;

console.log("What each subscription state means");
const t = (status: string, trialEndsAt: Date | null) =>
  subscriptionState({
    plan: "TRIAL",
    subscriptionStatus: status as never,
    trialEndsAt,
  });

check("ACTIVE writes", t("ACTIVE", null).readOnly === false);
check("a trial still running writes", t("TRIALING", new Date(Date.now() + 5 * DAY)).readOnly === false);
check(
  "and says so in its last week",
  (t("TRIALING", new Date(Date.now() + 5 * DAY)).notice ?? "").includes("5 days"),
);
check(
  "a trial with three weeks left says NOTHING",
  t("TRIALING", new Date(Date.now() + 21 * DAY)).notice === null,
);
check("an EXPIRED trial is read-only", t("TRIALING", new Date(Date.now() - DAY)).readOnly === true);
check(
  "a trial with no end date is open, not expired",
  t("TRIALING", null).readOnly === false,
  "the absence of a date must never read as 'ran out'",
);
check("PAST_DUE is read-only", t("PAST_DUE", null).readOnly === true);
check("SUSPENDED is read-only", t("SUSPENDED", null).readOnly === true);
check("CANCELLED is read-only", t("CANCELLED", null).readOnly === true);

console.log("\nMonthly billing");
const day = (n: number) => new Date(Date.now() + n * DAY);
const monthly = (paidUntil: Date | null) =>
  subscriptionState({
    plan: "INSTITUTION",
    subscriptionStatus: "ACTIVE",
    trialEndsAt: null,
    paidUntil,
  });

check("paid a fortnight ahead says nothing", monthly(day(14)).notice === null);
check(
  "three days out, it says so and still writes",
  monthly(day(3)).readOnly === false && (monthly(day(3)).notice ?? "").includes("3 days"),
);
check(
  "two days overdue is GRACE — still writing",
  monthly(day(-2)).readOnly === false && monthly(day(-2)).inGrace === true,
  monthly(day(-2)).notice ?? "",
);
check("and it says how long is left", (monthly(day(-2)).notice ?? "").includes("5 more days"));
check("eight days overdue is read-only", monthly(day(-8)).readOnly === true);
check(
  "⚠️ ACTIVE with no date is NOT treated as arrears",
  monthly(null).readOnly === false,
  "a school being set up by hand must not be punished for a missing field",
);

/**
 * ⚠️ The arithmetic that quietly steals a month.
 *
 * Advancing from TODAY instead of from the date already held shortens every late
 * month — pay four days late, get twenty-six days — and across a year a school
 * pays thirteen times without anyone deciding to charge them that.
 */
const paidTo = new Date("2026-03-10T00:00:00Z");
const payingLate = new Date("2026-03-14T00:00:00Z");
const advanced = nextDueDate(paidTo, payingLate);
check(
  "paying 4 days late still buys a whole month from the date held",
  advanced.toISOString().slice(0, 10) === "2026-04-10",
  advanced.toISOString().slice(0, 10),
);

// But a lapse so old that advancing would still leave them overdue starts today:
// taking money and handing back a read-only system is indefensible.
const longLapsed = new Date(Date.now() - 90 * DAY);
check(
  "a long-lapsed school is paid a month from TODAY, not from its old date",
  nextDueDate(longLapsed).getTime() > Date.now() + 27 * DAY,
);

console.log("\nWhat read-only actually stops");
const school = await withBypass(() =>
  prisma.school.findFirst({ where: { slug: { not: { startsWith: "qa-" } } } }),
);
const schoolId = school!.id;

// A read, under read-only: must still work. This is the whole point of the
// choice — a head teacher mid-term keeps their records.
const readCount = await runWithTenantContext({ schoolId, readOnly: true }, async () =>
  prisma.student.count({ where: { deletedAt: null } }),
);
check("a school in arrears can still READ its pupils", readCount > 0, `${readCount} pupils`);

let refused: unknown = null;
try {
  // ⚠️ `async` and awaited INSIDE the scope. A Prisma promise is lazy, so
  // `run(ctx, () => prisma.x.create(...))` hands back an unexecuted promise and
  // the storage scope exits before the query runs — the context is then empty
  // and the write sails through. CI failed on exactly this, and it is the same
  // trap CLAUDE.md records for withBypass.
  await runWithTenantContext({ schoolId, readOnly: true }, async () => {
    await prisma.house.create({ data: { schoolId, name: `readonly probe ${Date.now()}` } });
  });
} catch (error) {
  refused = error;
}
check(
  "but a WRITE is refused",
  refused instanceof SchoolReadOnlyError,
  refused instanceof Error ? refused.name : "nothing thrown",
);

const stray = await withBypass(() =>
  prisma.house.count({ where: { schoolId, name: { startsWith: "readonly probe" } } }),
);
check("and nothing was written", stray === 0, `${stray} rows`);

/**
 * ⚠️ The check that nearly did not exist.
 *
 * Every server action calls `setTenantContext({ schoolId: auth.schoolId })` right
 * after requireRole. With replace semantics that threw away the readOnly the auth
 * gate had just resolved — leaving a perfect guard in prisma.ts that nothing ever
 * reached, and an unpaid school writing exactly as before while every test passed.
 */
let survived: unknown = null;
try {
  await runWithTenantContext({ schoolId, readOnly: true }, async () => {
    // exactly what an action does, one line after requireRole
    setTenantContext({ schoolId });
    await prisma.house.create({ data: { schoolId, name: `rescope probe ${Date.now()}` } });
  });
} catch (error) {
  survived = error;
}
check(
  "re-scoping to the same school does NOT lose read-only",
  survived instanceof SchoolReadOnlyError,
  survived instanceof Error ? survived.name : "the write went through",
);

/**
 * ⚠️ And inside a transaction, which is where most writes in this app happen.
 *
 * The first version of this guard sat after `if (!RLS_ON || !model || inTx)
 * return query(args)`, so every operation inside `tenantTransaction` skipped it:
 * invoicing, promotion and results computation all write that way. CI caught the
 * RLS-off half; this is the half that would otherwise have reached production
 * with the guard looking perfect.
 */
let inTransaction: unknown = null;
try {
  await runWithTenantContext({ schoolId, readOnly: true }, () =>
    tenantTransaction(schoolId, (tx) =>
      tx.house.create({ data: { schoolId, name: `tx probe ${Date.now()}` } }),
    ),
  );
} catch (error) {
  inTransaction = error;
}
check(
  "a write inside tenantTransaction is refused too",
  inTransaction instanceof SchoolReadOnlyError ||
    (inTransaction instanceof Error && inTransaction.message.includes("read-only")),
  inTransaction instanceof Error ? inTransaction.name : "the transaction went through",
);

const txStray = await withBypass(() =>
  prisma.house.count({ where: { schoolId, name: { startsWith: "tx probe" } } }),
);
check("and that transaction wrote nothing", txStray === 0, `${txStray} rows`);

// The console has to be able to lift it — otherwise reactivating a suspended
// school would be refused by the suspension, and the only way out is the database.
const lifted = await runWithTenantContext({ schoolId, readOnly: true }, async () =>
  withBypass(async () => prisma.school.findUnique({ where: { id: schoolId }, select: { id: true } })),
);
check("withBypass lifts it, so the console can reactivate a school", lifted !== null);

// And a school in good standing is untouched by any of this.
let wroteFine = false;
const probeName = `subscription probe ${Date.now()}`;
try {
  await runWithTenantContext({ schoolId, readOnly: false }, async () => {
    await prisma.house.create({ data: { schoolId, name: probeName } });
  });
  wroteFine = true;
} catch {
  wroteFine = false;
}
check("a paid-up school writes normally", wroteFine);
await withBypass(() => prisma.house.deleteMany({ where: { schoolId, name: probeName } }));

console.log("\nThe pupil cap");

/**
 * ⚠️ Every path that creates a pupil must ask first.
 *
 * Read off the source rather than trusted: a third admission path — a bulk
 * transfer, an admissions portal — added without `admissionBlocked` would ignore
 * the cap in silence, and a plan limit nobody enforces is a price list nobody
 * pays. Same check verify:activity runs for audit phrases, same reason.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const creators = walk("src/lib").filter((file) => {
  const body = readFileSync(file, "utf8");
  return /\b(?:tx|prisma)\.student\.create(?:Many)?\b/.test(body);
});
const unguarded = creators.filter((file) => !readFileSync(file, "utf8").includes("admissionBlocked"));

check(
  "every file that creates a pupil asks the cap first",
  creators.length > 0 && unguarded.length === 0,
  unguarded.length ? `missing in: ${unguarded.join(", ")}` : `${creators.length} file(s), all guarded`,
);

const capped = { plan: "INSTITUTION" as const, studentCap: 150 };
check("a school under its cap may admit", capacityMessage(capacity(capped, 149), 1, "Institution") === null);
check(
  "a school AT its cap may not",
  (capacityMessage(capacity(capped, 150), 1, "Institution") ?? "").includes("at its limit"),
);
check(
  "an import that would cross the cap is refused whole, with the arithmetic",
  (capacityMessage(capacity(capped, 100), 80, "Institution") ?? "").includes("180"),
  capacityMessage(capacity(capped, 100), 80, "Institution") ?? "",
);
check(
  "and says nothing was written",
  (capacityMessage(capacity(capped, 100), 80, "Institution") ?? "").includes("Nothing has been imported"),
);
check(
  "a school ALREADY over its cap keeps its pupils — only new admissions refuse",
  capacity(capped, 200).full === true && capacity(capped, 200).onRoll === 200,
  "no pupil is withdrawn to satisfy a billing question",
);
check(
  "an explicit cap beats the plan default",
  pupilCap({ plan: "INSTITUTION", studentCap: 400 }) === 400,
);
check(
  "no plan carries a cap of its own — a limit is a decision about one school",
  (Object.keys(PLANS) as (keyof typeof PLANS)[]).every((p) => PLANS[p].studentCap === null),
);
check(
  "the trial is limited by TIME, not by roll size",
  TRIAL_DAYS === 7 && PLANS.TRIAL.studentCap === null,
  `${TRIAL_DAYS} days, uncapped`,
);
check(
  "the one paid plan is priced",
  PLANS.INSTITUTION.monthlyPrice === 800,
  `Institution GH₵${PLANS.INSTITUTION.monthlyPrice} a month`,
);
check(
  // Guards the thing that was actually wrong: two plans that differed only in
  // price. If a second paid plan is ever added, it has to DO something.
  "there is exactly one paid plan, and a free trial",
  Object.keys(PLANS).length === 2 && PLANS.TRIAL.monthlyPrice === 0,
  Object.keys(PLANS).join(", "),
);

/**
 * ⚠️ Nobody writes the plan's name out by hand.
 *
 * Renaming "Institution Plus" to "Institution" touched the enum, the schema,
 * the seed, the console and this file — and still shipped the OLD name on the
 * landing page, because the pricing card had the string typed into it rather
 * than read from PLANS. A grep for the identifier found nothing; only loading
 * the page did.
 *
 * Checked for PAID plans only: "Trial" is an ordinary English word that appears
 * in prose ("7 days free", "ask for a free trial"), and a rule with false
 * positives is a rule people learn to skip.
 */
const paidLabels = (Object.values(PLANS) as { label: string; monthlyPrice: number | null }[])
  .filter((p) => (p.monthlyPrice ?? 0) > 0)
  .map((p) => p.label);

/**
 * ⚠️ Its OWN walker, because `walk` above only returns `.ts`.
 *
 * Reusing it made this check pass with "Institution" typed straight back into
 * marketing.tsx — the guard could not see the one file kind that had the bug,
 * and a guard that cannot fail is worse than none. Forced red before it was
 * believed.
 */
const screens = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? screens(full) : /\.tsx?$/.test(full) ? [full] : [];
  });

const hardcoded: string[] = [];
for (const file of screens("src")) {
  if (file.endsWith("subscription.ts")) continue;
  const text = readFileSync(file, "utf8");
  for (const label of paidLabels) {
    if (text.includes(label)) hardcoded.push(`${file} (${label})`);
  }
}
check(
  "no screen types a plan's name out by hand",
  hardcoded.length === 0,
  hardcoded.length ? hardcoded.join(", ") : `${paidLabels.join(", ")} — read from PLANS everywhere`,
);

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
process.exit(failed === 0 ? 0 : 1);
