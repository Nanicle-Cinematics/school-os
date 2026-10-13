/**
 * How long a session lasts: the numbers, the verdict, and that the two readers agree on it.
 *
 * Pure: no database, no server. The HTTP half (a real request, a real row) is verify:session-lifetime.
 *
 * What is pinned here and why each number is written down in a test rather than left to the
 * constants: they are a judgement about who is hurt by a forced sign-in, and a number that moves
 * by accident (a 30 typed over a 3) quietly signs every school out, or never signs anyone out.
 *
 * Run: npm run verify:session-policy
 */
import { readFileSync } from "node:fs";
import {
  PLATFORM_POLICY,
  STAFF_POLICY,
  PARENT_POLICY,
  EXTEND_AFTER_MS,
  policyFor,
  initialExpiry,
  evaluateSession,
} from "@/lib/session-policy";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = new Date("2026-10-13T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const ahead = (ms: number) => new Date(now.getTime() + ms);

console.log("The numbers");
check("platform admin: 2 hours idle, 12 hours absolute", PLATFORM_POLICY.idleMs === 2 * HOUR && PLATFORM_POLICY.absoluteMs === 12 * HOUR);
check("staff: 7 days idle, 30 days absolute", STAFF_POLICY.idleMs === 7 * DAY && STAFF_POLICY.absoluteMs === 30 * DAY);
check("parent only: 30 days, unchanged, because a forced sign-in costs the school a text message", PARENT_POLICY.idleMs === 30 * DAY && PARENT_POLICY.absoluteMs === 30 * DAY);
check("a session is pushed forward at most every 10 minutes, so a busy page does not write on every request", EXTEND_AFTER_MS === 10 * MIN);
check("no policy lets idle outlast absolute", [PLATFORM_POLICY, STAFF_POLICY, PARENT_POLICY].every((p) => p.idleMs <= p.absoluteMs));
check("the console is the strictest on both clocks", PLATFORM_POLICY.idleMs < STAFF_POLICY.idleMs && PLATFORM_POLICY.absoluteMs < STAFF_POLICY.absoluteMs);

console.log("\nWho gets which");
check("a platform admin gets the console rules", policyFor({ isPlatformAdmin: true, roles: [] }) === PLATFORM_POLICY);
check("even one who also holds school roles (the console is the more dangerous door)", policyFor({ isPlatformAdmin: true, roles: ["OWNER"] }) === PLATFORM_POLICY);
check("a parent and nothing else gets the parent rules", policyFor({ isPlatformAdmin: false, roles: ["PARENT"] }) === PARENT_POLICY);
check("a parent at two schools is still a parent", policyFor({ isPlatformAdmin: false, roles: ["PARENT", "PARENT"] }) === PARENT_POLICY);
check("anyone who is also staff anywhere gets the staff rules", policyFor({ isPlatformAdmin: false, roles: ["PARENT", "TEACHER"] }) === STAFF_POLICY);
check("a head teacher gets the staff rules", policyFor({ isPlatformAdmin: false, roles: ["HEAD"] }) === STAFF_POLICY);
check("a login with no memberships is NOT treated as a parent (an empty list is not 'all parents')", policyFor({ isPlatformAdmin: false, roles: [] }) === STAFF_POLICY);

console.log("\nA new session");
const created = now;
check("staff: the first deadline is the idle span", initialExpiry(created, STAFF_POLICY).getTime() === created.getTime() + 7 * DAY);
check("platform admin: 2 hours", initialExpiry(created, PLATFORM_POLICY).getTime() === created.getTime() + 2 * HOUR);
check("parent: 30 days", initialExpiry(created, PARENT_POLICY).getTime() === created.getTime() + 30 * DAY);
check("a fresh session is live and needs no extension", (() => {
  const v = evaluateSession({ createdAt: created, expiresAt: initialExpiry(created, STAFF_POLICY) }, STAFF_POLICY, now);
  return v.live && v.extendTo === null;
})());

console.log("\nIdle: the deadline moves with use");
const midLife = { createdAt: ago(10 * DAY), expiresAt: ahead(4 * DAY) }; // last pushed three days ago
const used = evaluateSession(midLife, STAFF_POLICY, now);
check("a staff session last used three days ago is live", used.live);
check("and is pushed out to seven days from now", used.extendTo?.getTime() === now.getTime() + 7 * DAY, String(used.extendTo?.toISOString()));
check("a session idle past its deadline is dead", !evaluateSession({ createdAt: ago(3 * DAY), expiresAt: ago(1000) }, STAFF_POLICY, now).live);
check("at the exact deadline it is dead (a deadline is not 'one more millisecond')", !evaluateSession({ createdAt: ago(3 * DAY), expiresAt: now }, STAFF_POLICY, now).live);
const recent = evaluateSession({ createdAt: ago(1 * HOUR), expiresAt: ahead(7 * DAY - 5 * MIN) }, STAFF_POLICY, now);
check("used within the last 10 minutes: no write", recent.live && recent.extendTo === null);
const slightlyStale = evaluateSession({ createdAt: ago(1 * HOUR), expiresAt: ahead(7 * DAY - 15 * MIN) }, STAFF_POLICY, now);
check("used 15 minutes ago: pushed forward", slightlyStale.live && slightlyStale.extendTo !== null);

console.log("\nAbsolute: a busy session still ends");
check("past the absolute end it is dead however recently it was used", !evaluateSession({ createdAt: ago(31 * DAY), expiresAt: ahead(5 * DAY) }, STAFF_POLICY, now).live);
check("at the exact absolute end it is dead", !evaluateSession({ createdAt: ago(30 * DAY), expiresAt: ahead(5 * DAY) }, STAFF_POLICY, now).live);
const nearEnd = evaluateSession({ createdAt: ago(29 * DAY), expiresAt: ahead(1 * DAY) }, STAFF_POLICY, now);
check("near the end the deadline cannot be pushed past it", nearEnd.live && nearEnd.extendTo === null, String(nearEnd.extendTo));
const almost = evaluateSession({ createdAt: ago(29 * DAY + 12 * HOUR), expiresAt: ahead(6 * DAY) }, STAFF_POLICY, now);
check("and one with a deadline already beyond the end is pulled BACK to it", almost.live && almost.extendTo?.getTime() === now.getTime() + 12 * HOUR, String(almost.extendTo?.toISOString()));

console.log("\nSessions issued BEFORE these rules (every one that exists on the day this ships)");
const legacy = (ageMs: number) => ({ createdAt: ago(ageMs), expiresAt: new Date(ago(ageMs).getTime() + 30 * DAY) });
const legacyStaff = evaluateSession(legacy(5 * DAY), STAFF_POLICY, now);
check("a 30-day staff session is live, so nobody is signed out when this deploys", legacyStaff.live);
check("and its far-off deadline is brought UNDER the idle rule (earlier than stored)", legacyStaff.extendTo?.getTime() === now.getTime() + 7 * DAY && legacyStaff.extendTo.getTime() < legacy(5 * DAY).expiresAt.getTime());
const legacyParent = evaluateSession(legacy(5 * DAY), PARENT_POLICY, now);
check("a parent's session is left exactly as it was: no write at all, for the people with the most of them", legacyParent.live && legacyParent.extendTo === null);
check("a platform admin session older than 12 hours is refused outright", !evaluateSession(legacy(13 * HOUR), PLATFORM_POLICY, now).live);
const legacyAdmin = evaluateSession(legacy(5 * HOUR), PLATFORM_POLICY, now);
check("one younger than that is live, and held to two hours idle", legacyAdmin.live && legacyAdmin.extendTo?.getTime() === now.getTime() + 2 * HOUR, String(legacyAdmin.extendTo?.toISOString()));
const adminNearEnd = evaluateSession(legacy(11 * HOUR + 30 * MIN), PLATFORM_POLICY, now);
check("and in the last half hour of its twelve it gets only what is left", adminNearEnd.live && adminNearEnd.extendTo?.getTime() === now.getTime() + 30 * MIN, String(adminNearEnd.extendTo?.toISOString()));

console.log("\nBoth readers reach the same verdict");
// Comments out: this codebase explains its mistakes at length, and the words would satisfy a search.
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const main = code("src/lib/session.ts");
const light = code("src/lib/session-school.ts");
check("getSessionUser decides with evaluateSession and policyFor", /evaluateSession\(/.test(main) && /policyFor\(/.test(main));
check("so does the light reader the crest and icon routes use, so it cannot honour a session the main one ended", /evaluateSession\(/.test(light) && /policyFor\(/.test(light));
check("neither compares expiresAt on its own any more (the old check, which could not know about idle or absolute)", !/expiresAt\s*<\s*new Date/.test(main) && !/expiresAt\s*<\s*new Date/.test(light));
check("only the main reader writes: the light one never extends or deletes", !/session\.(update|delete)/.test(light));
check("createSession cannot be called without a policy (no default, so no one silently gets the wrong rules)", /policy:\s*SessionPolicy\s*\}/.test(main) && !/policy\?:/.test(main));
check("the old fixed 30 days is gone", !/SESSION_DAYS/.test(main));

console.log("\nThe cookie");
check("httpOnly, so script on the page cannot read it", /httpOnly:\s*true/.test(main));
check("sameSite lax, because a parent opens the portal from a text message and strict would sign them out", /sameSite:\s*"lax"/.test(main));
check("secure in production", /secure:\s*process\.env\.NODE_ENV\s*===\s*"production"/.test(main));
check("the browser's copy ends at the ABSOLUTE limit, not at the idle deadline", /expires:\s*new Date\(createdAt\.getTime\(\)\s*\+\s*opts\.policy\.absoluteMs\)/.test(main));
const defs = ["src/lib/session.ts", "src/lib/session-school.ts", "src/lib/account-actions.ts", "src/lib/session-cookie.ts"]
  .map((f) => (readFileSync(f, "utf8").match(/["']school_os_session["']/g) ?? []).length);
check("the cookie's name is spelt in exactly one place in src", defs.reduce((a, b) => a + b, 0) === 1 && SESSION_COOKIE_NAME === "school_os_session", defs.join(","));

console.log("\nLeftovers");
const stillThere = [".env.example", ".github/workflows/ci.yml", ".github/workflows/backup.yml", ".github/workflows/school-backup.yml"].filter((f) => /SESSION_SECRET/.test(readFileSync(f, "utf8")));
check("SESSION_SECRET (never read by anything) is gone from every tracked file", stillThere.length === 0, stillThere.join(", "));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
