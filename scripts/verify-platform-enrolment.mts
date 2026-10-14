/**
 * A platform admin's enrolment code, through the running app: an attacker who holds only the password.
 *
 * verify:enrolment-code proves the code and the shape of the source. This proves the doors are shut:
 * real sessions for the admin and for someone who has only the password, the real forms posted without
 * JavaScript, and the rows read back. The attacker session is the point. It is given everything a
 * password buys (a signed-in session on the security page, even the secret an earlier setup left
 * pending, and a valid authenticator code for it) and must still be unable to enrol.
 *
 * Every refusal has a positive control: the forged confirm is refused for the password-only session AND
 * the identical form succeeds for the session that presented the code.
 *
 * It also runs the SQL the scripts print for the production editor, against this database, because that
 * is the path used when the database password is lost, and so the one least likely to have been run.
 *
 *   npm run dev
 *   npm run verify:platform-enrolment
 *
 * Needs TOTP_ENCRYPTION_KEY, on the server and here, to read back the secret the app made.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { base32Encode, codeAt, stepFor } from "@/lib/totp";
import { decryptSecret, encryptSecret } from "@/lib/totp-crypto";
import { hashEnrolmentCode } from "@/lib/enrolment-code";
import { verifyPassword } from "@/lib/password";
import { newEnrolmentCode } from "./enrolment-code.mjs";
import { withOwner } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const PAGE = "/admin/security";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const unescape = (v: string) => v.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

type Reply = { status: number; location: string; html: string };
async function get(path: string, token: string): Promise<Reply> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const r = await fetch(BASE + path, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` }, redirect: "manual", signal: AbortSignal.timeout(120_000) });
      const html = await r.text();
      if (r.status === 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { status: r.status, location: r.headers.get("location") ?? "", html };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}
const forms = (html: string) => [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].map((m) => m[1]);
const formWith = (html: string, marker: string) => forms(html).find((inner) => inner.includes(marker));
function fieldsOf(inner: string): [string, string][] {
  const out: [string, string][] = [];
  for (const tag of inner.match(/<input\b[^>]*>/g) ?? []) {
    const type = tag.match(/type="([^"]*)"/)?.[1] ?? "text";
    if (type === "checkbox" || type === "submit") continue;
    const name = tag.match(/name="([^"]*)"/)?.[1];
    if (name) out.push([unescape(name), unescape(tag.match(/value="([^"]*)"/)?.[1] ?? "")]);
  }
  return out;
}
/** Never retried: a write that was retried may have been applied twice. */
async function post(token: string, fields: [string, string][], overrides: Record<string, string> = {}): Promise<Reply> {
  const body = new FormData();
  const seen = new Set<string>();
  for (const [name, value] of fields) {
    body.append(name, name in overrides ? overrides[name] : value);
    seen.add(name);
  }
  for (const [name, value] of Object.entries(overrides)) if (!seen.has(name)) body.append(name, value);
  const r = await fetch(BASE + PAGE, { method: "POST", headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` }, body, redirect: "manual", signal: AbortSignal.timeout(180_000) });
  const html = await r.text();
  return { status: r.status, location: r.headers.get("location") ?? "", html };
}

async function main() {
  if (!(await fetch(BASE, { redirect: "manual" }).catch(() => null))) {
    console.log(`Nothing answers at ${BASE} — start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }
  if (!process.env.TOTP_ENCRYPTION_KEY) {
    console.log("TOTP_ENCRYPTION_KEY is not set here, so the secret the app makes cannot be read back.");
    process.exitCode = 1;
    return;
  }

  const stamp = Date.now();
  const userIds: string[] = [];
  const mkUser = async (label: string, extra: Record<string, unknown> = {}) => {
    const user = await withBypass(() =>
      prisma.user.create({ data: { name: `Probe ${label}`, email: `vpe-${label}-${stamp}@example.test`, passwordHash: "x", isPlatformAdmin: true, ...extra }, select: { id: true, email: true } }),
    );
    userIds.push(user.id);
    return user as { id: string; email: string };
  };
  const mkSession = async (userId: string, verified = false) => {
    const token = randomBytes(32).toString("hex");
    const row = await withBypass(() =>
      prisma.session.create({
        data: { userId, tokenHash: sha(token), expiresAt: new Date(Date.now() + 2 * 3600_000), ...(verified ? { enrolmentVerifiedAt: new Date() } : {}) },
        select: { id: true },
      }),
    );
    return { token, id: row.id };
  };
  const userRow = (id: string) => withBypass(() => prisma.user.findUniqueOrThrow({ where: { id } }));
  const sessionRow = (id: string) => withBypass(() => prisma.session.findUniqueOrThrow({ where: { id } }));

  // A run that crashed (a dropped database connection, a killed process) leaves its users behind. They
  // are all ours (`vpe-`), so clear them first rather than let the next run report them as its own.
  await withOwner(async (owner) => {
    await owner.session.deleteMany({ where: { user: { email: { startsWith: "vpe-" } } } });
    await owner.user.deleteMany({ where: { email: { startsWith: "vpe-" } } });
  });

  const issued = newEnrolmentCode();
  const admin = await mkUser("admin", { enrolmentCodeHash: issued.hash, enrolmentCodeExpiresAt: issued.expiresAt });
  const keysToClear = [`2fa:${admin.id}`];
  const s1 = await mkSession(admin.id); // the real admin: has the password AND the code
  const s2 = await mkSession(admin.id); // someone with only the password
  const s3 = await mkSession(admin.id, true); // a helper, marked as having presented the code, only to read the forms

  // The account bucket (8 per 15 minutes) AND the address bucket (30). Both matter: a run makes more
  // than eight attempts on one account, and back-to-back runs share one address, so without clearing
  // the second the guard fails from the THIRD run on with every early step rate-limited, which reads
  // exactly like the code being broken. Development databases only; this script is never run elsewhere.
  const resetAllowance = () =>
    withBypass(() =>
      prisma.loginAttempt.deleteMany({ where: { OR: [{ identifier: { startsWith: "2fa:" + admin.id } }, { identifier: { startsWith: "2fa-ip:" } }] } }),
    );
  const isRedirectHome = (r: Reply) => r.status === 303 && r.location.includes(PAGE);
  await resetAllowance();

  try {
    console.log("\nBefore the code: the password reaches a page with nothing on it");
    const startForm = formWith((await get(PAGE, s3.token)).html, "Set up two-factor sign-in");
    check("a session that HAS presented the code is offered the setup (the forms we will try to forge)", Boolean(startForm));

    // Someone with only the password had begun a setup, and so knows its secret.
    const secret0 = randomBytes(20);
    await withBypass(() => prisma.user.update({ where: { id: admin.id }, data: { totpSecretEnc: encryptSecret(secret0) } }));
    const verifiedWithPending = await get(PAGE, s3.token);
    const confirmForm0 = formWith(verifiedWithPending.html, 'name="code"');
    check("with a secret pending, a session that presented the code sees it, and a confirm form", Boolean(confirmForm0) && verifiedWithPending.html.includes(base32Encode(secret0).replace(/(.{4})/g, "$1 ").trim()));

    const gated = await get(PAGE, s1.token);
    check("the real admin, before the code, sees a box for it", gated.status === 200 && /name="enrolmentCode"/.test(gated.html));
    check("and no QR code", !/QR code to scan/.test(gated.html));
    check("and not the pending secret, in the clear", !gated.html.includes(base32Encode(secret0).replace(/(.{4})/g, "$1 ").trim()));
    check("and no setup button, and no confirm box", !/Set up two-factor sign-in/.test(gated.html) && !formWith(gated.html, 'name="code"'));
    const attacker = await get(PAGE, s2.token);
    check("the password-only session sees exactly the same: a box for the code, no secret", /name="enrolmentCode"/.test(attacker.html) && !/QR code to scan/.test(attacker.html) && !attacker.html.includes(base32Encode(secret0).replace(/(.{4})/g, "$1 ").trim()));

    console.log("\nA password-only session cannot enrol, even knowing the secret");
    const code0 = codeAt(secret0, stepFor(Date.now()));
    await post(s2.token, fieldsOf(confirmForm0!), { code: code0 });
    check("a valid authenticator code for the pending secret, replayed from the confirm form, enrols nothing", (await userRow(admin.id)).totpEnabledAt === null);
    const before = (await userRow(admin.id)).totpSecretEnc;
    await post(s2.token, fieldsOf(startForm!));
    check("the setup button replayed makes no new secret", (await userRow(admin.id)).totpSecretEnc === before);
    check("and the session is still not marked", (await sessionRow(s2.id)).enrolmentVerifiedAt === null);

    console.log("\nThe code itself");
    const codeForm = formWith(gated.html, 'name="enrolmentCode"')!;
    const wrong = await post(s1.token, fieldsOf(codeForm), { enrolmentCode: newEnrolmentCode().code });
    check("a wrong code is refused, in words that do not say why", /wrong or has expired/.test(wrong.html));
    check("and the session is not marked", (await sessionRow(s1.id)).enrolmentVerifiedAt === null);
    await post(s1.token, fieldsOf(codeForm), { enrolmentCode: "" });
    await resetAllowance();

    await withBypass(() => prisma.user.update({ where: { id: admin.id }, data: { enrolmentCodeExpiresAt: new Date(Date.now() - 1000) } }));
    const lapsed = await post(s1.token, fieldsOf(codeForm), { enrolmentCode: issued.code });
    check("the right code, once it has expired, gets the SAME answer as a wrong one", /wrong or has expired/.test(lapsed.html) && (await sessionRow(s1.id)).enrolmentVerifiedAt === null);
    await withBypass(() => prisma.user.update({ where: { id: admin.id }, data: { enrolmentCodeExpiresAt: issued.expiresAt } }));

    const right = await post(s1.token, fieldsOf(codeForm), { enrolmentCode: issued.code.toLowerCase().replace(/-/g, " ") });
    check("the right code, typed in lower case with spaces, is accepted", isRedirectHome(right), `HTTP ${right.status} ${right.location}`);
    check("it marks THIS session", (await sessionRow(s1.id)).enrolmentVerifiedAt !== null);
    check("and no other", (await sessionRow(s2.id)).enrolmentVerifiedAt === null);
    check("and throws away the secret that was pending, which someone with only the password knew", (await userRow(admin.id)).totpSecretEnc === null);

    console.log("\nAfter the code");
    const open = await get(PAGE, s1.token);
    const start1 = formWith(open.html, "Set up two-factor sign-in");
    check("the admin is now offered the setup", Boolean(start1) && !/name="enrolmentCode"/.test(open.html));
    check("while the password-only session still sees the code box", /name="enrolmentCode"/.test((await get(PAGE, s2.token)).html));
    await post(s1.token, fieldsOf(start1!));
    const secret1 = decryptSecret((await userRow(admin.id)).totpSecretEnc ?? "");
    check("setup makes a new secret, not the one that was known", Buffer.compare(secret1, secret0) !== 0);
    const pendingPage = await get(PAGE, s1.token);
    const key1 = base32Encode(secret1).replace(/(.{4})/g, "$1 ").trim();
    check("which the admin's session is shown, with its QR code", pendingPage.html.includes(key1) && /QR code to scan/.test(pendingPage.html));
    const sneak = await get(PAGE, s2.token);
    check("and the password-only session is not", !sneak.html.includes(key1) && !/QR code to scan/.test(sneak.html));

    const confirmForm1 = formWith(pendingPage.html, 'name="code"')!;
    const code1 = codeAt(secret1, stepFor(Date.now()));
    await post(s2.token, fieldsOf(confirmForm1), { code: code1 });
    check("with the secret and a valid code in hand, the password-only session still cannot enrol", (await userRow(admin.id)).totpEnabledAt === null);

    const enrol = await post(s1.token, fieldsOf(confirmForm1), { code: code1 });
    const after = await userRow(admin.id);
    check("the identical form from the admin's session DOES enrol (the control: the forgery was well-formed)", after.totpEnabledAt !== null);
    check("and shows ten recovery codes, once", (enrol.html.match(/[A-Z2-7]{5}-[A-Z2-7]{5}/g) ?? []).length >= 10);
    check("the enrolment code is spent: hash and expiry cleared", after.enrolmentCodeHash === null && after.enrolmentCodeExpiresAt === null);

    console.log("\nOnce enrolled");
    const s4 = await mkSession(admin.id);
    await post(s4.token, fieldsOf(codeForm), { enrolmentCode: issued.code });
    check("the spent code opens nothing, from a new session", (await sessionRow(s4.id)).enrolmentVerifiedAt === null);

    console.log("\nA new phone, from inside");
    await resetAllowance();
    // ⚠️ A session that signed in AFTER enrolment and passed the authenticator, and so never presented
    // the enrolment code (it was spent long ago). It is the one the waiver exists for: without it the
    // admin replacing their phone would be asked for a code that no longer exists, and be locked out of
    // re-enrolment until someone with database access intervened. The admin's FIRST session would not
    // show this: it presented the code earlier and stays marked whether or not the waiver is there.
    const s8 = await mkSession(admin.id);
    await withBypass(() => prisma.session.update({ where: { id: s8.id }, data: { mfaVerifiedAt: new Date() } }));
    check("the session replacing the phone has NOT presented any enrolment code (so the check below cannot pass by accident)", (await sessionRow(s8.id)).enrolmentVerifiedAt === null);
    const manage = await get(PAGE, s8.token);
    const replaceForm = forms(manage.html).find((inner) => inner.includes("Replace authenticator"));
    check("it is offered 'Replace authenticator'", Boolean(replaceForm));
    if (replaceForm) {
      // The step just used is spent, so the next one: inside the verifier's window.
      await post(s8.token, fieldsOf(replaceForm), { code: codeAt(secret1, stepFor(Date.now()) + 1) });
      const replaced = await userRow(admin.id);
      check("the authenticator is cleared", replaced.totpEnabledAt === null && replaced.totpSecretEnc === null);
      check("and THIS session, which just proved the old one, is marked as having presented a code", (await sessionRow(s8.id)).enrolmentVerifiedAt !== null);
      check("so it is offered the setup straight away, with no code box", Boolean(formWith((await get(PAGE, s8.token)).html, "Set up two-factor sign-in")) && !/name="enrolmentCode"/.test((await get(PAGE, s8.token)).html));
      const s5 = await mkSession(admin.id);
      check("but a new session is back to needing one", /name="enrolmentCode"/.test((await get(PAGE, s5.token)).html));
      const none = await post(s5.token, fieldsOf(codeForm), { enrolmentCode: issued.code });
      check("and with no code on record, nothing opens it (closed, not open)", (await sessionRow(s5.id)).enrolmentVerifiedAt === null && /wrong or has expired/.test(none.html));
    }

    console.log("\nThe SQL printed for the production editor, run here");
    const runScript = (args: string[], input?: string) =>
      execFileSync("node_modules/.bin/tsx", ["scripts/platform.mts", ...args], { encoding: "utf8", input, env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" } });
    const statement = (out: string) => out.split(/^─{10,}$/m)[1]?.trim() ?? "";

    await resetAllowance();
    const reissue = runScript(["sql-enrolment-code", admin.email]);
    const reissued = reissue.match(/Enrolment code:\s+([A-Z0-9-]+)/)?.[1] ?? "";
    const changed = await withOwner((db) => db.$executeRawUnsafe(statement(reissue)));
    check("the re-issue statement updates exactly the one unenrolled admin", changed === 1, `${changed} row`);
    const s6 = await mkSession(admin.id);
    const gate6 = await get(PAGE, s6.token);
    const reply6 = await post(s6.token, fieldsOf(formWith(gate6.html, 'name="enrolmentCode"')!), { enrolmentCode: reissued });
    check("and the code it printed opens the setup", isRedirectHome(reply6) && (await sessionRow(s6.id)).enrolmentVerifiedAt !== null);

    const enrolled = await mkUser("enrolled", { totpEnabledAt: new Date() });
    const forEnrolled = runScript(["sql-enrolment-code", enrolled.email]);
    const touched = await withOwner((db) => db.$executeRawUnsafe(statement(forEnrolled)));
    check("the same statement for an admin who has ALREADY enrolled changes nothing", touched === 0 && (await userRow(enrolled.id)).enrolmentCodeHash === null, `${touched} rows`);

    const email = `vpe-sql-${stamp}@example.test`;
    const created = runScript(["sql", email], "Probe-password-2026\n");
    const createdCode = created.match(/Enrolment code:\s+([A-Z0-9-]+)/)?.[1] ?? "";
    await withOwner((db) => db.$executeRawUnsafe(statement(created)));
    const made = await withBypass(() => prisma.user.findFirst({ where: { email } }));
    if (made) userIds.push(made.id);
    check("the create-or-promote statement makes a platform admin with a hash that matches the code printed beside it", Boolean(made?.isPlatformAdmin) && made?.enrolmentCodeHash === hashEnrolmentCode(createdCode));
    check("expiring about 48 hours from now", Boolean(made?.enrolmentCodeExpiresAt) && Math.abs((made!.enrolmentCodeExpiresAt!.getTime() - Date.now()) - 48 * 3600_000) < 15 * 60_000, String(made?.enrolmentCodeExpiresAt?.toISOString()));
    check("with the password that was chosen (so the account really can sign in)", Boolean(made?.passwordHash) && (await verifyPassword("Probe-password-2026", made!.passwordHash!)));
    if (made) {
      const s7 = await mkSession(made.id);
      const gate7 = await get(PAGE, s7.token);
      const reply7 = await post(s7.token, fieldsOf(formWith(gate7.html, 'name="enrolmentCode"')!), { enrolmentCode: createdCode });
      check("and that code opens the setup for it", isRedirectHome(reply7) && (await sessionRow(s7.id)).enrolmentVerifiedAt !== null);
    }
  } finally {
    await withOwner(async (db) => {
      await db.session.deleteMany({ where: { userId: { in: userIds } } });
      await db.loginAttempt.deleteMany({
        where: { OR: [{ identifier: { in: [...keysToClear, ...userIds.map((id) => `2fa:${id}`)] } }, { identifier: { startsWith: "2fa-ip:" } }] },
      });
      await db.user.deleteMany({ where: { id: { in: userIds } } });
    });
    const left = await withBypass(() => prisma.user.count({ where: { id: { in: userIds } } }));
    check("fixtures removed", left === 0, `${left} left`);
    // Here, not after the try: a throw above must not skip the verdict.
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  }
}

await main();
await prisma.$disconnect();
