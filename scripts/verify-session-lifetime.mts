/**
 * Session lifetime, through the running app: a real request, a real row.
 *
 * verify:session-policy proves the rules as arithmetic. This proves they are applied: that a
 * session the rules have ended is turned away at the door, that a live one's deadline moves in the
 * database, and that signing in through the real form issues the cookie and deadline each kind of
 * person is meant to get.
 *
 * Sessions are planted with exact ages straight into the database (the only way to test "31 days
 * old" without waiting), then used over HTTP. Liveness is read from where a request ends up: a
 * dead session is sent to /login, a live one is not.
 *
 * Fixtures: three users (staff, a parent, a platform admin), their memberships and sessions, all
 * deleted at the end together with the rate-limit rows the sign-ins leave behind.
 *
 *   npm run dev
 *   npm run verify:session-lifetime
 */
import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPasswordWith, LEGACY_PARAMS } from "@/lib/password";
import { SESSION_COOKIE_NAME } from "@/lib/session-cookie";
import { demoSchool } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const near = (actual: Date | null | undefined, expected: number, within: number) =>
  actual !== null && actual !== undefined && Math.abs(actual.getTime() - expected) <= within;

/** Where a request ends up. Retries a 500, which on this link is usually a dropped connection. */
async function probe(path: string, token: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
      await r.text();
      if (r.status === 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return { status: r.status, location: r.headers.get("location") ?? "" };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}
const sentToLogin = (r: { status: number; location: string }) => r.status >= 300 && r.status < 400 && r.location.includes("/login");

async function plant(userId: string, schoolId: string | null, createdAgo: number, expiresIn: number) {
  const token = randomBytes(32).toString("hex");
  const createdAt = new Date(Date.now() - createdAgo);
  const expiresAt = new Date(Date.now() + expiresIn);
  await withBypass(() =>
    prisma.session.create({
      data: { userId, tokenHash: hash(token), activeSchoolId: schoolId ?? undefined, createdAt, expiresAt },
    }),
  );
  return { token, createdAt, expiresAt };
}
const row = (token: string) => withBypass(() => prisma.session.findUnique({ where: { tokenHash: hash(token) } }));

// --- the sign-in form, as a person uses it --------------------------------------------------------
const decode = (v: string) => v.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
async function loginFields(): Promise<[string, string][]> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const html = await (await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(120_000) })).text();
      const form = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)].find((f) => /Sign in/.test(f[1].replace(/<[^>]+>/g, " ")));
      if (form) {
        return [...form[1].matchAll(/<input\b[^>]*>/g)]
          .map((t) => [t[0].match(/name="([^"]*)"/)?.[1] ?? "", decode(t[0].match(/value="([^"]*)"/)?.[1] ?? "")] as [string, string])
          .filter(([n]) => n && n !== "identifier" && n !== "password");
      }
    } catch {
      // A dev server still compiling answers slowly: retry.
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error("the login page never offered a Sign in form");
}
async function signIn(identifier: string, password: string) {
  const body = new FormData();
  for (const [n, v] of await loginFields()) body.append(n, v);
  body.append("identifier", identifier);
  body.append("password", password);
  const r = await fetch(`${BASE}/login`, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  await r.text();
  const cookie = r.headers.getSetCookie?.().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  const token = cookie.match(new RegExp(`^${SESSION_COOKIE_NAME}=([^;]+)`))?.[1] ?? "";
  const expires = cookie.match(/Expires=([^;]+)/i)?.[1];
  return { signedIn: Boolean(token), token, cookieExpires: expires ? new Date(expires) : null, cookie };
}

async function main() {
  if (!(await fetch(BASE, { redirect: "manual" }).catch(() => null))) {
    console.log(`Nothing answers at ${BASE} — start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }

  const school = await demoSchool();
  const stamp = Date.now();
  const password = `Lifetime-${stamp}-Pw!`;
  const passwordHash = await hashPasswordWith(password, LEGACY_PARAMS);
  const emails = { staff: `vsl-staff-${stamp}@example.test`, parent: `vsl-parent-${stamp}@example.test`, admin: `vsl-admin-${stamp}@example.test` };

  const staff = await withBypass(() => prisma.user.create({ data: { name: "VSL Staff", email: emails.staff, passwordHash, schoolId: school.id } }));
  const parent = await withBypass(() => prisma.user.create({ data: { name: "VSL Parent", email: emails.parent, passwordHash, schoolId: school.id } }));
  const admin = await withBypass(() => prisma.user.create({ data: { name: "VSL Admin", email: emails.admin, passwordHash, isPlatformAdmin: true } }));
  await withBypass(() => prisma.membership.create({ data: { schoolId: school.id, userId: staff.id, role: "ACCOUNTANT" } }));
  await withBypass(() => prisma.membership.create({ data: { schoolId: school.id, userId: parent.id, role: "PARENT" } }));
  const userIds = [staff.id, parent.id, admin.id];

  // Light, fast, and open to anyone signed in; a dead session is sent to /login, a live one is not.
  const STAFF_PATH = "/account/password";
  const ADMIN_PATH = "/admin";

  try {
    console.log("\nStaff: idle");
    const used = await plant(staff.id, school.id, 10 * DAY, 4 * DAY);
    check("a session last used three days ago is let in", !sentToLogin(await probe(STAFF_PATH, used.token)));
    const afterUse = await row(used.token);
    check("and its deadline was pushed out to seven days from now, in the database", near(afterUse?.expiresAt, Date.now() + 7 * DAY, 5 * MIN), String(afterUse?.expiresAt.toISOString()));
    check("its created date is untouched (the absolute clock never moves)", afterUse?.createdAt.getTime() === used.createdAt.getTime());

    const idle = await plant(staff.id, school.id, 3 * DAY, -1 * MIN);
    check("a session past its idle deadline is sent to /login", sentToLogin(await probe(STAFF_PATH, idle.token)));
    check("and its row is removed, since nothing else would", (await row(idle.token)) === null);

    console.log("\nStaff: absolute");
    const old = await plant(staff.id, school.id, 31 * DAY, 10 * DAY);
    check("a 31-day-old session is sent to /login however far off its deadline is", sentToLogin(await probe(STAFF_PATH, old.token)));

    console.log("\nSessions issued before these rules");
    const legacyStaff = await plant(staff.id, school.id, 5 * DAY, 25 * DAY);
    check("a 30-day staff session is still let in, so nobody is signed out at deploy", !sentToLogin(await probe(STAFF_PATH, legacyStaff.token)));
    check("and its deadline is brought under the idle rule (down to seven days)", near((await row(legacyStaff.token))?.expiresAt, Date.now() + 7 * DAY, 5 * MIN));

    console.log("\nParent");
    const legacyParent = await plant(parent.id, school.id, 5 * DAY, 25 * DAY);
    check("a parent's session is let in", !sentToLogin(await probe(STAFF_PATH, legacyParent.token)));
    check("and left EXACTLY as it was: no write at all", (await row(legacyParent.token))?.expiresAt.getTime() === legacyParent.expiresAt.getTime());

    console.log("\nPlatform admin");
    const adminOld = await plant(admin.id, null, 13 * HOUR, 25 * DAY);
    check("a console session older than 12 hours is sent to /login", sentToLogin(await probe(ADMIN_PATH, adminOld.token)));
    const adminNew = await plant(admin.id, null, 1 * HOUR, 25 * DAY);
    check("a younger one is let in (on to enrolment, not to /login)", !sentToLogin(await probe(ADMIN_PATH, adminNew.token)));
    check("and held to two hours idle", near((await row(adminNew.token))?.expiresAt, Date.now() + 2 * HOUR, 5 * MIN));

    console.log("\nSigning in through the real form");
    const stale = await plant(staff.id, school.id, 40 * DAY, -10 * DAY);
    const s = await signIn(emails.staff, password);
    const sRow = s.signedIn ? await row(s.token) : null;
    check("staff: signs in", s.signedIn);
    check("staff: the deadline is seven days idle", near(sRow?.expiresAt, Date.now() + 7 * DAY, 5 * MIN), String(sRow?.expiresAt.toISOString()));
    check("staff: the browser's cookie lasts the 30-day absolute limit", near(s.cookieExpires, Date.now() + 30 * DAY, 2 * HOUR), String(s.cookieExpires?.toISOString()));
    check("staff: it is httpOnly and lax", /HttpOnly/i.test(s.cookie) && /SameSite=lax/i.test(s.cookie));
    check("signing in also removed this person's sessions that had already ended", (await row(stale.token)) === null);

    const p = await signIn(emails.parent, password);
    const pRow = p.signedIn ? await row(p.token) : null;
    check("parent: signs in, with a 30-day deadline and cookie", p.signedIn && near(pRow?.expiresAt, Date.now() + 30 * DAY, 5 * MIN) && near(p.cookieExpires, Date.now() + 30 * DAY, 2 * HOUR));

    const a = await signIn(emails.admin, password);
    const aRow = a.signedIn ? await row(a.token) : null;
    check("platform admin: signs in", a.signedIn);
    check("platform admin: the deadline is two hours idle", near(aRow?.expiresAt, Date.now() + 2 * HOUR, 5 * MIN), String(aRow?.expiresAt.toISOString()));
    check("platform admin: the browser's cookie lasts twelve hours", near(a.cookieExpires, Date.now() + 12 * HOUR, 10 * MIN), String(a.cookieExpires?.toISOString()));
  } finally {
    await withBypass(() => prisma.session.deleteMany({ where: { userId: { in: userIds } } }));
    for (const email of Object.values(emails)) {
      await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: { contains: email } } }));
    }
    await withBypass(() => prisma.membership.deleteMany({ where: { userId: { in: userIds } } }));
    await withBypass(() => prisma.user.deleteMany({ where: { id: { in: userIds } } }));
    const left = await withBypass(() => prisma.user.count({ where: { id: { in: userIds } } }));
    check("fixtures removed", left === 0, `${left} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
await prisma.$disconnect();
