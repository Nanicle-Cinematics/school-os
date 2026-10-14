/**
 * The platform admin's enrolment code: the code itself, and that nothing in the app or the scripts
 * can be reached without it.
 *
 * Pure: no database and no server. The HTTP half (a real session, a real form, a real row) is
 * verify:platform-enrolment.
 *
 * Three things are pinned. The CODE: its alphabet, its shape, its entropy, its expiry, and that what
 * the scripts ISSUE (`scripts/enrolment-code.mjs`, plain JavaScript) is accepted by what the app
 * CHECKS (`src/lib/enrolment-code.ts`), because they are separate implementations and a drift
 * between them would lock out every new admin. The SHAPE of the app, read from source with
 * comments stripped (this codebase explains its mistakes at length, and the words would satisfy a
 * search): setup is gated per SESSION, a code is spent when enrolment completes, and the app never
 * ISSUES one. And the SQL the scripts print for the production editor, which is the path used when
 * the database password is lost, so it is the one least likely to have been run before it is needed.
 *
 * Run: npm run verify:enrolment-code
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ENROLMENT_CODE_HOURS, newEnrolmentCode } from "./enrolment-code.mjs";
import { enrolmentCodeAccepted, hashEnrolmentCode, normalizeEnrolmentCode } from "@/lib/enrolment-code";
import { hashRecoveryCode } from "@/lib/totp-crypto";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SHAPE = /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/;
const now = new Date("2026-10-14T12:00:00Z");

console.log("What is issued");
const sample = Array.from({ length: 6000 }, () => newEnrolmentCode(now.getTime()));
check("every code is XXXX-XXXX-XXXX, with no 0, O, 1, I or L (it is read aloud and typed from a phone)", sample.every((c) => SHAPE.test(c.code)));
check("no two of six thousand are the same", new Set(sample.map((c) => c.code)).size === sample.length);
const counts = new Map<string, number>();
for (const c of sample) for (const ch of c.code.replace(/-/g, "")) counts.set(ch, (counts.get(ch) ?? 0) + 1);
const expected = (sample.length * 12) / 31;
const worst = Math.max(...[...counts.values()].map((n) => Math.abs(n - expected) / expected));
check("all 31 symbols turn up, about equally often (rejection sampling, not modulo)", counts.size === 31 && worst < 0.1, `worst ${(worst * 100).toFixed(1)}% off`);
check("about 59 bits: twelve symbols from thirty-one", Math.round(12 * Math.log2(31)) === 59);
check("it lapses after the stated number of hours", sample[0].expiresAt.getTime() === now.getTime() + ENROLMENT_CODE_HOURS * 3600_000 && ENROLMENT_CODE_HOURS === 48);

console.log("\nWhat the app accepts");
const issued = newEnrolmentCode(now.getTime());
const stored = { hash: issued.hash, expiresAt: issued.expiresAt };
check("a code the SCRIPTS issued is accepted by the APP (two implementations that must agree)", sample.slice(0, 300).every((c) => enrolmentCodeAccepted(c.code, { hash: c.hash, expiresAt: c.expiresAt }, now)));
check("and both compute the same hash", sample.slice(0, 300).every((c) => hashEnrolmentCode(c.code) === c.hash));
check("lower case is the same code", enrolmentCodeAccepted(issued.code.toLowerCase(), stored, now));
check("so is one typed without the dashes", enrolmentCodeAccepted(issued.code.replace(/-/g, ""), stored, now));
check("so is one with spaces", enrolmentCodeAccepted(issued.code.replace(/-/g, " "), stored, now));
const other = newEnrolmentCode(now.getTime());
check("a different code is refused", !enrolmentCodeAccepted(other.code, stored, now));
const nudged = issued.code.slice(0, -1) + (issued.code.endsWith("A") ? "B" : "A");
check("a code one character out is refused", !enrolmentCodeAccepted(nudged, stored, now));
check("a code with a character missing is refused", !enrolmentCodeAccepted(issued.code.slice(0, -1), stored, now));
check("empty and blank are refused", !enrolmentCodeAccepted("", stored, now) && !enrolmentCodeAccepted("  --  ", stored, now));
check("one second before it lapses it is accepted", enrolmentCodeAccepted(issued.code, stored, new Date(issued.expiresAt.getTime() - 1000)));
check("at the moment it lapses it is not", !enrolmentCodeAccepted(issued.code, stored, issued.expiresAt));
check("after it has lapsed it is not", !enrolmentCodeAccepted(issued.code, stored, new Date(issued.expiresAt.getTime() + 1)));
check("with no code on record nothing is accepted, not even an empty hash", !enrolmentCodeAccepted(issued.code, { hash: null, expiresAt: issued.expiresAt }, now) && !enrolmentCodeAccepted("", { hash: "", expiresAt: issued.expiresAt }, now));
check("with no expiry on record nothing is accepted", !enrolmentCodeAccepted(issued.code, { hash: issued.hash, expiresAt: null }, now));
check("a stored hash that is not hex is refused rather than thrown on", !enrolmentCodeAccepted(issued.code, { hash: "not-a-hash", expiresAt: issued.expiresAt }, now));
check("normalising drops everything but letters and digits", normalizeEnrolmentCode("ab-cd 12!") === "ABCD12");

console.log("\nThe hash is its own thing");
const plain = createHash("sha256").update(normalizeEnrolmentCode(issued.code)).digest("hex");
check("it is not the bare SHA-256 of the code, so a recovery code or a token cannot stand in for it", hashEnrolmentCode(issued.code) !== plain);
check("nor the hash a recovery code would have", hashEnrolmentCode(issued.code) !== hashRecoveryCode(issued.code));

console.log("\nSetup is gated, per session");
const actions = code("src/lib/platform-2fa-actions.ts");
const fn = (name: string) => {
  const start = actions.indexOf(`export async function ${name}`);
  const next = actions.indexOf("export async function", start + 10);
  return actions.slice(start, next === -1 ? undefined : next);
};
check("startSetup refuses a session that has not presented the code", /session\.enrolmentVerifiedAt/.test(fn("startSetup")) && /requirePlatformAdminSession\(\)/.test(fn("startSetup")));
check("and does so before it makes a secret", fn("startSetup").indexOf("enrolmentVerifiedAt") < fn("startSetup").indexOf("encryptSecret"));
check("confirmSetup refuses it as well (the secret may already be pending when it is called)", /session\.enrolmentVerifiedAt/.test(fn("confirmSetup")));
check("and does so before it checks the TOTP code", fn("confirmSetup").indexOf("enrolmentVerifiedAt") < fn("confirmSetup").indexOf("verifyTotp"));
check("confirmSetup spends the code: hash and expiry cleared when enrolment completes", /enrolmentCodeHash:\s*null/.test(fn("confirmSetup")) && /enrolmentCodeExpiresAt:\s*null/.test(fn("confirmSetup")));
const submit = fn("submitEnrolmentCode");
check("submitEnrolmentCode counts every attempt against the small allowance", /withinLimit\(user\.id\)/.test(submit));
check("and checks the code with the one function, not a comparison of its own", /enrolmentCodeAccepted\(/.test(submit) && !/===\s*user\.enrolmentCodeHash/.test(submit));
check("a wrong, expired and absent code all get the same answer", (submit.match(/CODE_WRONG/g) ?? []).length === 1 && !/expired|no code/i.test(submit.replace(/CODE_WRONG/g, "")));
check("it discards a secret that was pending (made before this session proved anything)", /totpSecretEnc:\s*null/.test(submit));
check("and marks THIS session", /enrolmentVerifiedAt:\s*new Date\(\)/.test(submit) && /prisma\.session\.update\(\{\s*where:\s*\{\s*id:\s*session\.id/.test(submit));
check("replacing an authenticator waives the code for the session that proved the old one", /enrolmentVerifiedAt:\s*new Date\(\)/.test(fn("replaceAuthenticator")));
const writers = (actions.match(/enrolmentVerifiedAt:\s*new Date\(\)/g) ?? []).length;
check("only those two actions ever mark a session as having presented the code", writers === 2, `${writers}`);

console.log("\nThe app never issues a code");
const srcFiles = ["src/lib/platform-2fa-actions.ts", "src/lib/platform-auth.ts", "src/lib/auth-actions.ts", "src/lib/user-actions.ts", "src/app/admin/security/page.tsx"];
const assigns = srcFiles.flatMap((f) => (code(f).match(/enrolmentCodeHash:\s*[^,\n}]+/g) ?? []).map((m) => `${f}: ${m}`));
check("the only write of the hash anywhere in the app is the clearing to null", assigns.length === 1 && /null/.test(assigns[0]), assigns.join(" | "));

console.log("\nThe page");
const page = code("src/app/admin/security/page.tsx");
check("it decides whether a code is needed from THIS session", /needsCode\s*=\s*!enabled\s*&&\s*!session\.enrolmentVerifiedAt/.test(page));
check("a secret is shown only when no code is needed", /pending\s*=\s*!enabled\s*&&\s*!needsCode\s*&&/.test(page));
check("and the QR code is made only for a pending secret", /if \(pending && !problem\)/.test(page));
check("the code box comes before the setup button", page.indexOf("needsCode ? (") !== -1 && page.indexOf("needsCode ? (") < page.indexOf("<form action={startSetup}>"));

console.log("\nThe scripts");
const scripts = {
  makeAdmin: code("scripts/make-platform-admin.mjs"),
  reset: code("scripts/reset-platform-2fa.mjs"),
  platform: code("scripts/platform.mts"),
};
check("make:admin issues a code when it grants", /newEnrolmentCode\(\)/.test(scripts.makeAdmin) && /enrolmentCodeHash:\s*issued\.hash/.test(scripts.makeAdmin));
check("reset-platform-2fa issues a fresh one, since it is exactly when someone else may hold the password", /newEnrolmentCode\(\)/.test(scripts.reset) && /enrolmentCodeHash:\s*issued\.hash/.test(scripts.reset));
check("platform admin issues one, and only to an admin who has not enrolled", /existing\?\.totpEnabledAt \? null : newEnrolmentCode\(\)/.test(scripts.platform));
check("every script prints the warning to send it by a different route", [scripts.makeAdmin, scripts.reset, scripts.platform].every((s) => /enrolmentCodeNotice\(/.test(s)));
check("the SQL commands refuse an address that is not plain, since it is written into production SQL", /plainEmail\(argument\.trim\(\)\)/.test(scripts.platform));

console.log("\nThe SQL printed for the production editor");
const run = (args: string[]) => {
  try {
    return { out: execFileSync("node_modules/.bin/tsx", ["scripts/platform.mts", ...args], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "--conditions=react-server" }, stdio: ["ignore", "pipe", "pipe"] }), status: 0 };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, status: e.status ?? 1 };
  }
};
const printed = run(["sql-enrolment-code", "probe@example.test"]);
const printedCode = printed.out.match(/Enrolment code:\s+([A-Z0-9-]+)/)?.[1] ?? "";
const printedHash = printed.out.match(/"enrolmentCodeHash"\s*=\s*'([0-9a-f]{64})'/)?.[1] ?? "";
check("it prints a statement and the code", printed.status === 0 && SHAPE.test(printedCode) && printedHash.length === 64, `exit ${printed.status}`);
check("the hash in the statement is the hash the APP computes from the code printed beside it", hashEnrolmentCode(printedCode) === printedHash);
check("it sets a 48 hour expiry, in UTC, so a session in another time zone cannot shorten it", /\(now\(\) at time zone 'utc'\) \+ interval '48 hours'/.test(printed.out));
check("it only touches a platform admin who has not enrolled", /where email = 'probe@example\.test' and "isPlatformAdmin" = true and "totpEnabledAt" is null/.test(printed.out));
check("it says to send the code by a different route", /DIFFERENT route/.test(printed.out));
const hostile = run(["sql-enrolment-code", `x'; drop table "User"; --@a.com`]);
check("an address with a quote in it prints no SQL at all", hostile.status !== 0 && !/update "User"/.test(hostile.out));
const spaced = run(["sql-enrolment-code", "a b@example.test"]);
check("nor one with a space", spaced.status !== 0 && !/update "User"/.test(spaced.out));

console.log("\nThe migration");
const migration = readFileSync("prisma/migrations/20261014120000_platform_enrolment_code/migration.sql", "utf8").replace(/^--.*$/gm, "");
check("it only ADDS three nullable columns", (migration.match(/ADD COLUMN/g) ?? []).length === 3 && !/NOT NULL|DROP|ALTER COLUMN|DELETE|UPDATE/i.test(migration));
const schema = readFileSync("prisma/schema.prisma", "utf8");
check("the schema carries all three", /enrolmentCodeHash\s+String\?/.test(schema) && /enrolmentCodeExpiresAt\s+DateTime\?/.test(schema) && /enrolmentVerifiedAt\s+DateTime\?/.test(schema));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
