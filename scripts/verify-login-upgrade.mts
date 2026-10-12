/**
 * Signing in raises a password hash to the current cost, through the real login form.
 *
 * `verify:password` proves the arithmetic: what `checkPassword` computes for each kind of attempt,
 * and the shape of the login action as read from its source. It cannot see the action RUN, and the
 * action is where it matters: a form post, a database read, an upgrade written back, a session.
 * This signs in the way a person does, as an account whose password is stored at the OLD cost (the
 * state every existing account is in), and reads the row afterwards.
 *
 * Fixtures: one user and one membership, deleted at the end, along with the sessions and
 * rate-limit rows the sign-ins leave behind. It writes nothing else.
 *
 *   npm run dev
 *   npm run verify:login-upgrade
 */
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPasswordWith, verifyPassword, LEGACY_PARAMS } from "@/lib/password";
import { demoSchool } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const WRONG = "Incorrect email/phone or password.";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function decode(value: string) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** The login page's hidden fields (the action id Next renders into a no-JS form). */
async function loginFields(): Promise<[string, string][]> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const html = await (await fetch(`${BASE}/login`, { signal: AbortSignal.timeout(120_000) })).text();
      const forms = [...html.matchAll(/<form\b[^>]*>([\s\S]*?)<\/form>/g)];
      const form = forms.find((f) => /Sign in/.test(f[1].replace(/<[^>]+>/g, " ")));
      if (form) {
        return [...form[1].matchAll(/<input\b[^>]*>/g)]
          .map((tag) => [tag[0].match(/name="([^"]*)"/)?.[1] ?? "", decode(tag[0].match(/value="([^"]*)"/)?.[1] ?? "")] as [string, string])
          .filter(([name]) => name && name !== "identifier" && name !== "password");
      }
    } catch {
      // Retry below: a dev server that is still compiling answers slowly.
    }
    await sleep(500 * (attempt + 1));
  }
  throw new Error("the login page never offered a Sign in form");
}

async function signIn(identifier: string, password: string) {
  const body = new FormData();
  for (const [name, value] of await loginFields()) body.append(name, value);
  body.append("identifier", identifier);
  body.append("password", password);
  const response = await fetch(`${BASE}/login`, { method: "POST", body, redirect: "manual", signal: AbortSignal.timeout(120_000) });
  const html = await response.text();
  const raw = response.headers.getSetCookie?.().find((c) => c.includes(COOKIE));
  return { status: response.status, signedIn: Boolean(raw?.match(new RegExp(`${COOKIE}=([^;]+)`))?.[1]), html };
}

const readHash = async (id: string) => (await withBypass(() => prisma.user.findUnique({ where: { id }, select: { passwordHash: true } })))?.passwordHash ?? "";

async function main() {
  const probe = await fetch(BASE, { redirect: "manual" }).catch(() => null);
  if (!probe) {
    console.log(`Nothing answers at ${BASE} — start the app first (npm run dev).`);
    process.exitCode = 1;
    return;
  }

  const school = await demoSchool();
  const stamp = Date.now();
  const email = `verify-login-upgrade-${stamp}@example.test`;
  const password = `Upgrade-${stamp}-Pw!`;

  // Stored at the OLD cost, in the old three-field format: the state of every account that exists.
  const legacy = await hashPasswordWith(password, LEGACY_PARAMS);
  const user = await withBypass(() =>
    prisma.user.create({ data: { name: "Verify Login Upgrade", email, passwordHash: legacy, schoolId: school.id } }),
  );
  await withBypass(() => prisma.membership.create({ data: { schoolId: school.id, userId: user.id, role: "ACCOUNTANT" } }));

  try {
    console.log("\nThe fixture");
    check("starts at the old cost (three fields, no parameters)", legacy.split("$").length === 3 && (await readHash(user.id)) === legacy);

    console.log("\nA wrong password");
    const wrong = await signIn(email, "not-the-password");
    check("is refused with the same message as an unknown account", !wrong.signedIn && wrong.html.includes(WRONG));
    check("and changes nothing: the hash is the one it was", (await readHash(user.id)) === legacy);

    console.log("\nAn account that does not exist");
    const stranger = await signIn(`nobody-${stamp}@example.test`, "whatever");
    check("gets the identical message, so the form cannot be used to find accounts", !stranger.signedIn && stranger.html.includes(WRONG));

    console.log("\nThe right password");
    const first = await signIn(email, password);
    check("signs in", first.signedIn, `status ${first.status}`);
    const upgraded = await readHash(user.id);
    check("and the stored hash is now at the current cost, with its parameters", upgraded.startsWith("scrypt$ln=16,r=8,p=2$") && upgraded.split("$").length === 4, upgraded.slice(0, 22));
    check("it is a different hash, not the old one re-labelled", upgraded !== legacy);
    check("and the same password still opens it", await verifyPassword(password, upgraded));

    console.log("\nSigning in again");
    const second = await signIn(email, password);
    check("works with the same password", second.signedIn);
    check("and does not rewrite a hash that is already current", (await readHash(user.id)) === upgraded);

    console.log("\nA wrong password after the upgrade");
    const after = await signIn(email, "still-not-the-password");
    check("is refused", !after.signedIn && after.html.includes(WRONG));
    check("and leaves the upgraded hash alone", (await readHash(user.id)) === upgraded);
  } finally {
    // Sessions and rate-limit rows first: the sign-ins above left both behind.
    await withBypass(() => prisma.session.deleteMany({ where: { userId: user.id } }));
    await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: { contains: email } } }));
    await withBypass(() => prisma.loginAttempt.deleteMany({ where: { identifier: { contains: `nobody-${stamp}@example.test` } } }));
    await withBypass(() => prisma.membership.deleteMany({ where: { userId: user.id } }));
    await withBypass(() => prisma.user.delete({ where: { id: user.id } }));
    const left = await withBypass(() => prisma.user.count({ where: { email } }));
    check("fixture removed", left === 0, `${left} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
await prisma.$disconnect();
