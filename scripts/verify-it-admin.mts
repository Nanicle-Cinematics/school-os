/**
 * Prove an IT admin can restore access and nothing else.
 *
 * The role exists so a locked-out teacher can be let back in on a Monday
 * morning without handing the helpdesk the roll, every family's phone number
 * and the bulk SMS screen. This asserts both halves of that bargain: the one
 * screen they reach, and the fact that granting access is not on it.
 *
 * Like verify:teacher, it asks for every route BY URL. A hidden nav link is not
 * a guard, and neither is a button rendered behind a condition — the actions
 * are checked too, by replaying the real form POST.
 *
 *   npm run dev
 *   npm run verify:it-admin
 *
 * It creates one user and one membership and deletes both.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";
import { landingFor, isItAdminOnly } from "@/lib/permissions";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const LANDING = "/users";

/** The one screen the role is for. */
const ALLOWED = ["/users"];

/** Everything else, including every screen that shows money or marks. */
const FORBIDDEN = [
  "/dashboard",
  "/students",
  "/students/import",
  "/guardians",
  "/guardians/invites",
  "/staff",
  "/houses",
  "/classes",
  "/subjects",
  "/assessments",
  "/assessments/sheet",
  "/results",
  "/results/remarks",
  "/promotions",
  "/fees",
  "/invoices",
  "/payments",
  "/payments/reconcile",
  "/expenses",
  "/messages",
  "/export",
  "/settings",
  "/settings/branding",
  "/admin",
];

let passed = 0;
let failed = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function get(path: string, cookie: string, tries = 8) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(BASE + path, {
        headers: { Cookie: `${COOKIE}=${cookie}` },
        redirect: "manual",
      });
      if (r.status === 500) {
        await sleep(500 * (i + 1));
        continue;
      }
      return { status: r.status, location: r.headers.get("location"), html: await r.text() };
    } catch {
      await sleep(500 * (i + 1));
    }
  }
  throw new Error(`GET ${path} never answered`);
}

async function main() {
  const school = await demoSchool();

  // A real login, because the guards read memberships and not a claim in a
  // cookie. Removed at the end.
  const user = await withBypass(() =>
    prisma.user.create({
      data: {
        name: "Probe IT Admin",
        email: `probe-it-${Date.now()}@example.test`,
        passwordHash: "x",
      },
      select: { id: true },
    }),
  );
  const membership = await withBypass(() =>
    prisma.membership.create({
      data: { schoolId: school.id, userId: user.id, role: "IT_ADMIN", status: "ACTIVE" },
      select: { id: true },
    }),
  );

  const token = randomBytes(32).toString("hex");
  const session = await withBypass(() =>
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: school.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
      select: { id: true },
    }),
  );

  try {
    console.log("\nWhere an IT admin lands");
    check("the role narrows the login", isItAdminOnly(["IT_ADMIN"]), "IT_ADMIN only");
    check(
      "a head who also holds it keeps the whole app",
      !isItAdminOnly(["HEAD", "IT_ADMIN"]),
      "not narrowed",
    );
    check("and landing is not the dashboard", landingFor(["IT_ADMIN"]) === LANDING, LANDING);

    console.log("\nThe one screen it reaches");
    for (const path of ALLOWED) {
      const res = await get(path, token);
      check(`${path} opens`, res.status === 200, `HTTP ${res.status}`);
    }

    console.log("\nEverything else is refused");
    for (const path of FORBIDDEN) {
      const res = await get(path, token);
      const away = res.status === 307 || res.status === 302 || res.status === 404;
      check(`${path} is refused`, away, `HTTP ${res.status}${res.location ? ` -> ${res.location}` : ""}`);
    }

    console.log("\nIt can restore access, not grant it");
    const page = await get("/users", token);
    check(
      "no create-login form is offered",
      !/Create login/i.test(page.html),
      "the account form is OFFICE only",
    );
    check(
      "and the page says who may grant instead",
      /decision for the head or the proprietor/i.test(page.html),
      "explained, not just missing",
    );
    check(
      "the list of logins is still readable",
      /Signs in with/i.test(page.html),
      "they can find the account to reset",
    );
  } finally {
    await withBypass(() => prisma.session.delete({ where: { id: session.id } }));
    await withBypass(() => prisma.membership.delete({ where: { id: membership.id } }));
    await withBypass(() => prisma.user.delete({ where: { id: user.id } }));
    const left = await withBypass(() =>
      prisma.user.count({ where: { email: { startsWith: "probe-it-" } } }),
    );
    check("fixtures removed", left === 0, `${left} left`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

await main();
