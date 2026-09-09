/**
 * Prove a parent sees their own children and nothing else.
 *
 * The portal's isolation is NOT enforced by Postgres. RLS scopes every query to
 * the school, and two families are the same tenant — so the policies are
 * satisfied by another family's child just as readily as by their own. Family
 * isolation is application code, which means it is exactly the kind of guard
 * that passes review and fails in production.
 *
 * So this signs in as a real parent and asks for another family's child BY URL,
 * the way someone editing an id in the address bar would. It also asks for every
 * staff route, because hiding a link is not a guard — the lesson /students,
 * /classes and /subjects taught when they went on rendering for teachers.
 *
 *   npm run dev
 *   npm run verify:parent
 *
 * Fixtures: the demo seed has guardians but no parent LOGIN, so this creates one
 * user + membership and deletes both at the end. It writes nothing else.
 */

import { createHash, randomBytes } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { landingFor, isParentOnly } from "@/lib/permissions";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const LANDING = "/portal";

/** Staff screens a parent must never render. */
const FORBIDDEN = [
  "/dashboard",
  "/students",
  "/guardians",
  "/staff",
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
  "/expenses",
  "/messages",
  "/users",
  "/settings",
  "/search",
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
  // Two families whose children do not overlap. Without a second family there is
  // nothing to prove, so this skips loudly rather than passing vacuously.
  const guardians = await withBypass(() =>
    prisma.guardian.findMany({
      where: { deletedAt: null, students: { some: { student: { deletedAt: null } } } },
      select: {
        id: true,
        schoolId: true,
        firstName: true,
        lastName: true,
        students: { select: { studentId: true } },
      },
      take: 50,
    }),
  );

  // Prefer a family whose child actually has results, so the publication checks
  // run instead of skipping. Picking guardians[0] blindly chose a child with no
  // results at all, and the two checks that matter most quietly said "--".
  const withResults = await withBypass(() =>
    prisma.termResult.findMany({ select: { studentId: true, status: true } }),
  );
  const published = new Set(
    withResults.filter((r) => r.status === "PUBLISHED").map((r) => r.studentId),
  );
  const unpublished = new Set(
    withResults.filter((r) => r.status !== "PUBLISHED").map((r) => r.studentId),
  );
  const score = (g: (typeof guardians)[number]) =>
    g.students.reduce(
      (best, s) =>
        Math.max(
          best,
          (published.has(s.studentId) ? 2 : 0) + (unpublished.has(s.studentId) ? 1 : 0),
        ),
      0,
    );
  guardians.sort((a, b) => score(b) - score(a));

  const mine = guardians[0];
  if (!mine) {
    console.log("--   no guardian with a linked child in this database; nothing to verify");
    return;
  }
  const myKids = new Set(mine.students.map((s) => s.studentId));
  const other = guardians.find(
    (g) => g.id !== mine.id && g.students.every((s) => !myKids.has(s.studentId)),
  );
  if (!other) {
    console.log("--   only one family in this database; cross-family checks skipped");
    return;
  }

  // Likewise within the family: the child with results, not merely the first.
  const myChild =
    [...myKids].find((id) => published.has(id) && unpublished.has(id)) ??
    [...myKids].find((id) => published.has(id)) ??
    [...myKids].find((id) => unpublished.has(id)) ??
    [...myKids][0];
  const theirChild = other.students[0].studentId;

  // --- fixture: a login for `mine` -----------------------------------------
  const stamp = Date.now();
  const user = await withBypass(() =>
    prisma.user.create({
      data: {
        name: `${mine.firstName} ${mine.lastName}`,
        email: `verify-parent-${stamp}@example.test`,
        schoolId: mine.schoolId,
      },
    }),
  );
  await withBypass(() =>
    prisma.membership.create({
      data: { schoolId: mine.schoolId, userId: user.id, role: "PARENT", guardianId: mine.id },
    }),
  );

  const token = randomBytes(32).toString("hex");
  await withBypass(() =>
    prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: createHash("sha256").update(token).digest("hex"),
        activeSchoolId: mine.schoolId,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    }),
  );

  try {
    console.log(`\nSigned in as ${mine.firstName} ${mine.lastName} (parent)\n`);

    check("a parent-only login lands on the portal", landingFor(["PARENT"]) === LANDING);
    check("isParentOnly recognises the role", isParentOnly(["PARENT"]));
    check("a head who is also a parent keeps the app", !isParentOnly(["HEAD", "PARENT"]));

    console.log("");
    for (const path of [
      "/portal",
      `/portal/${myChild}`,
      `/portal/${myChild}/fees`,
      `/portal/${myChild}/results`,
    ]) {
      const r = await get(path, token);
      check(`${path} opens`, r.status === 200, `status ${r.status}`);
    }

    console.log("");
    // The whole point. 404 rather than 403 so a parent cannot tell "not yours"
    // from "does not exist" and enumerate the roll one id at a time.
    for (const path of [
      `/portal/${theirChild}`,
      `/portal/${theirChild}/fees`,
      `/portal/${theirChild}/results`,
    ]) {
      const r = await get(path, token);
      check(
        `${path} — another family's child is refused`,
        r.status === 404,
        r.status === 200 ? "RENDERED — LEAK" : `status ${r.status}`,
      );
    }

    console.log("");
    // An unpublished report card must be invisible even for their own child.
    const draft = await withBypass(() =>
      prisma.termResult.findFirst({
        where: { studentId: myChild, status: { not: "PUBLISHED" } },
        select: { termId: true },
      }),
    );
    if (draft) {
      const r = await get(`/portal/${myChild}/results/${draft.termId}`, token);
      check(
        "an unpublished report card is not shown",
        r.status === 404,
        r.status === 200 ? "RENDERED — LEAK" : `status ${r.status}`,
      );
    } else {
      console.log("--   no unpublished result for this child; publication check skipped");
    }

    // The report-card view is the one page a parent most wants and the only one
    // that renders shared print components, so it must not go untested merely
    // because the demo seed publishes nothing. If there is no published result,
    // publish a draft, look, and put it back — the same force-and-restore
    // verify:attention uses. Development databases only.
    const live = await withBypass(() =>
      prisma.termResult.findFirst({
        where: { studentId: myChild, status: "PUBLISHED" },
        select: { termId: true },
      }),
    );

    if (live) {
      const r = await get(`/portal/${myChild}/results/${live.termId}`, token);
      check("a published report card opens", r.status === 200, `status ${r.status}`);
    } else if (draft) {
      const row = await withBypass(() =>
        prisma.termResult.findFirst({
          where: { studentId: myChild, termId: draft.termId },
          select: { id: true, status: true, publishedAt: true },
        }),
      );
      if (!row) throw new Error("the draft result vanished between reads");
      try {
        await withBypass(() =>
          prisma.termResult.update({
            where: { id: row.id },
            data: { status: "PUBLISHED", publishedAt: new Date() },
          }),
        );
        const r = await get(`/portal/${myChild}/results/${draft.termId}`, token);
        check(
          "a published report card opens (forced, then restored)",
          r.status === 200,
          `status ${r.status}`,
        );
      } finally {
        await withBypass(() =>
          prisma.termResult.update({
            where: { id: row.id },
            data: { status: row.status, publishedAt: row.publishedAt },
          }),
        );
        const back = await withBypass(() =>
          prisma.termResult.findUnique({ where: { id: row.id }, select: { status: true } }),
        );
        check("the forced result was restored", back?.status === row.status, `now ${back?.status}`);
      }
    } else {
      console.log("--   no result of any kind for this child; report-card view skipped");
    }

    console.log("");
    for (const path of FORBIDDEN) {
      const r = await get(path, token);
      const refused = r.status >= 300 && r.status < 400;
      check(
        `${path} is refused`,
        refused,
        refused ? `-> ${r.location}` : `status ${r.status} — RENDERED`,
      );
    }
  } finally {
    // Fixtures out, whatever happened above.
    await withBypass(() => prisma.session.deleteMany({ where: { userId: user.id } }));
    await withBypass(() => prisma.membership.deleteMany({ where: { userId: user.id } }));
    await withBypass(() => prisma.user.delete({ where: { id: user.id } }));
    console.log("\nfixtures removed");
  }
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
