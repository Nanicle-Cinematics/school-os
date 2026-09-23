/**
 * Prove an IT admin runs the school's systems and stays out of its money.
 *
 * The role exists so a locked-out teacher can be let back in on a Monday
 * morning without handing the helpdesk the roll, every family's phone number
 * and the bulk SMS screen. It may now also create that teacher's login in the
 * first place (see ACCOUNT_CREATOR in permissions.ts) — widened on request —
 * but never one that reaches the money: `createUserAccount` refuses an
 * IT-admin-only actor who tries to grant ACCOUNTANT or ADMIN. This asserts the
 * FINANCE half of that bargain — the routes it may never open, and the fact
 * that the money never appears on a screen it does reach.
 *
 * Like verify:teacher, it asks for every route BY URL. A hidden nav link is not
 * a guard, and neither is a button rendered behind a condition.
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
import { landingFor } from "@/lib/permissions";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const LANDING = "/dashboard";

/**
 * Everything an IT admin runs the school with. Asserted by URL, not by reading
 * the nav — a link that is merely rendered proves nothing about the guard.
 */
const ALLOWED = [
  "/dashboard",
  "/students",
  "/students/import",
  "/guardians",
  "/guardians/invites",
  "/staff",
  "/houses",
  "/classes",
  "/attendance",
  "/subjects",
  "/assessments",
  "/results",
  "/promotions",
  "/messages",
  "/export",
  "/users",
  "/settings",
  "/settings/sms",
  "/settings/branding",
  "/settings/terms",
  "/settings/structure",
  "/settings/grading",
  "/settings/components",
];

/**
 * ⚠️ The money, and nothing else.
 *
 * This list IS the boundary. It is expressed as routes rather than as a role
 * set on purpose: the point of the check is that a screen guarded by FINANCE
 * stays shut even after somebody widens a constant somewhere else.
 */
const FORBIDDEN = [
  "/fees",
  "/invoices",
  "/payments",
  "/payments/reconcile",
  "/expenses",
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
    check("it lands on the dashboard like any office role", landingFor(["IT_ADMIN"]) === LANDING, LANDING);

    console.log("\nIt runs the school");
    for (const path of ALLOWED) {
      const res = await get(path, token);
      check(`${path} opens`, res.status === 200, `HTTP ${res.status}`);
    }

    /**
     * The broadsheet takes a class and a term and calls notFound() without
     * them, so a bare GET is 404 for a proprietor too. The thing worth
     * asserting is that it is not REFUSED — a 307 here would mean the role
     * cannot reach it at all.
     */
    const broadsheet = await get("/results/broadsheet", token);
    check(
      "/results/broadsheet is reachable (404 without a class, not refused)",
      broadsheet.status !== 307 && broadsheet.status !== 302,
      `HTTP ${broadsheet.status}`,
    );

    console.log("\nBut not the money");
    for (const path of FORBIDDEN) {
      const res = await get(path, token);
      const away = res.status === 307 || res.status === 302 || res.status === 404;
      check(`${path} is refused`, away, `HTTP ${res.status}${res.location ? ` -> ${res.location}` : ""}`);
    }

    /**
     * ⚠️ Until this was the deliberate policy: IT_ADMIN could not create ANY
     * login, because the account-creating role also picks the new account's
     * roles and could mint itself into the money. Widened on request — see
     * ACCOUNT_CREATOR in permissions.ts — so IT_ADMIN now opens this door too,
     * but `createUserAccount` refuses an IT-admin-only actor who tries to grant
     * ACCOUNTANT or ADMIN on the new account. That server-side refusal is
     * exercised directly (bk3m9whrm, run by hand) rather than here: the create
     * form sits behind a client `useState` toggle and is absent from the SSR
     * HTML, so — same limitation `verify:actions` already documents — a no-JS
     * POST replay cannot reach it. What this script CAN still prove without
     * a browser is that the door is open and the boundary is explained.
     */
    console.log("\nIt can create a login, but not one that reaches the money");
    const page = await get("/users", token);
    check(
      "a create-login form is now offered",
      /Create login/i.test(page.html),
      "IT admin may create a staff login — see ACCOUNT_CREATOR in permissions.ts",
    );
    check(
      "and the page explains the finance/admin boundary",
      /finance or administrator access/i.test(page.html),
      "IT admin can open the door but not walk all the way through it",
    );

    console.log("\nAnd the dashboard tells it nothing about money");
    /**
     * ⚠️ The money was gated on the tiles and the chart and NOT on the attention
     * card, so "26 families owe GH₵24,158" reached every non-finance role. A
     * boundary spread across call sites leaks from the one nobody listed.
     */
    const dash = await get("/dashboard", token);
    check(
      "no collections figure on the dashboard",
      !/Collected/i.test(dash.html) && !/Outstanding/i.test(dash.html),
      "the money tiles stay hidden",
    );
    check(
      "and the attention card names no debt",
      !/families owe/i.test(dash.html) && !/family owes/i.test(dash.html),
      "what is owed is finance's to see",
    );

    console.log("\nExports carry no money either");
    const exports = await get("/export", token);
    check("the export page opens", exports.status === 200, `HTTP ${exports.status}`);
    /**
     * ⚠️ Match the download LINK, not the word.
     *
     * The first version of this tested /Invoices/i against the whole page and
     * failed — on the term selector's own label, "Term, for invoices, payments
     * and results". Prose, not an offer. A guard that reports a leak which is
     * not there costs the same afternoon as one that misses a leak that is.
     */
    check(
      "but offers no invoices or payments to download",
      !exports.html.includes("/api/export/invoices") &&
        !exports.html.includes("/api/export/payments"),
      "those datasets are FINANCE",
    );
    check(
      "while the ones it may have are offered",
      exports.html.includes("/api/export/students"),
      "students, guardians, staff",
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
