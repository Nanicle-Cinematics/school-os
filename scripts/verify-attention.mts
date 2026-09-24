/**
 * Prove the dashboard's "Needs your attention" rules.
 *
 * Two halves. The first recounts each rule the long way and compares — cheap,
 * and it catches a rule that has silently stopped matching. The second FORCES
 * each condition, because a rule that never fires against the demo data is a
 * rule nobody has tested: the seed has every class fully staffed and every
 * current-term assessment APPROVED, so marking and staffing are quiet by
 * default and stayed quiet through the first version of this file.
 *
 * It WRITES: removes a teaching assignment, reopens one assessment and drops
 * two of its scores — then puts all three back and asserts the totals match
 * what it started with. Development databases only.
 *
 *   npm run verify:attention
 */

import { prisma } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { demoSchool } from "./fixture.mjs";
import { getAttention, getDashboard } from "@/lib/dashboard-data";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const school = await demoSchool();
setTenantContext({ schoolId: school.id });

const data = await getDashboard(school.id);
if (!data.term) {
  console.log("no current term — nothing to check");
  await prisma.$disconnect();
  process.exit(0);
}
const term = { id: data.term.id, academicYearId: data.term.academicYearId };
const fees = { outstanding: data.outstanding, debtorCount: data.debtorCount };
const ask = () => getAttention(school.id, term, fees);

/**
 * The same recount part one does, pulled out so part two can use it too.
 *
 * A dev database is never as empty as CI's fresh seed — real marking happens
 * against it, and a school-in-progress has unfinished sheets of its own before
 * this script forces one more. Comparing against a fixed "1 sheet" or "no
 * marking item at all" only worked by accident, on a baseline of zero this
 * script never actually guaranteed. Recounting instead of assuming a baseline
 * is what part one already did — part two just needs the same ground truth.
 */
async function unfinishedCount() {
  const enrolments = await prisma.enrollment.findMany({
    where: { academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { classGroupId: true },
  });
  const roster = new Map<string, number>();
  for (const row of enrolments) roster.set(row.classGroupId, (roster.get(row.classGroupId) ?? 0) + 1);

  const assessments = await prisma.assessment.findMany({
    where: { termId: term.id, status: { not: "APPROVED" } },
    select: { id: true, classGroupId: true, _count: { select: { scores: true } } },
  });
  return assessments.filter((a) => a._count.scores < (roster.get(a.classGroupId) ?? 0)).length;
}

// ── Half one: does it agree with a recount? ─────────────────────────────────
console.log("\nAgainst the database as it stands");
{
  const items = await ask();
  console.log(`  (${items.map((i) => i.tag).join(", ") || "nothing"})`);

  const unfinished = await unfinishedCount();
  const marking = items.find((i) => i.kind === "marking");
  check(
    "marking agrees with a recount",
    (unfinished === 0) === !marking && (!marking || marking.title.startsWith(String(unfinished))),
    `${unfinished} unfinished`,
  );

  const unpublished = await prisma.termResult.count({
    where: { termId: term.id, status: { not: "PUBLISHED" } },
  });
  const results = items.find((i) => i.kind === "results");
  check(
    "unpublished report cards agree",
    (unpublished === 0) === !results && (!results || results.title.startsWith(String(unpublished))),
    `${unpublished} unpublished`,
  );

  check("fees appears exactly when someone owes", (fees.debtorCount > 0) === Boolean(items.find((i) => i.kind === "fees")),
    `${fees.debtorCount} debtors`);
  check("every item links somewhere", items.every((i) => i.href.startsWith("/")),
    items.map((i) => i.href).join(", ") || "—");
}

// ── Half two: force each condition ──────────────────────────────────────────
console.log("\nWith a gap forced into the data");
{
  const victim = await prisma.teachingAssignment.findFirst({
    where: { academicYearId: term.academicYearId },
  });
  if (!victim) {
    console.log("  --   no teaching assignment to remove");
  } else {
    const before = await prisma.teachingAssignment.count({
      where: { academicYearId: term.academicYearId },
    });
    await prisma.teachingAssignment.delete({ where: { id: victim.id } });
    const staffing = (await ask()).find((i) => i.kind === "staffing");
    check("removing one assignment raises staffing", Boolean(staffing), staffing?.title ?? "(absent)");
    check("counted in classes, not subjects", staffing?.title.startsWith("1 class") ?? false,
      staffing?.title ?? "");

    await prisma.teachingAssignment.create({
      data: {
        schoolId: victim.schoolId,
        academicYearId: victim.academicYearId,
        staffId: victim.staffId,
        classGroupId: victim.classGroupId,
        subjectId: victim.subjectId,
      },
    });
    check("clears once it is back", !(await ask()).find((i) => i.kind === "staffing"));
    check("and the roll is whole again",
      (await prisma.teachingAssignment.count({ where: { academicYearId: term.academicYearId } })) === before);
  }

  // A sheet that is currently FINISHED — approved, or already fully scored —
  // so forcing it open adds exactly one to whatever the baseline already was,
  // rather than possibly re-counting a sheet that was unfinished to begin with.
  const baselineUnfinished = await unfinishedCount();
  const rosterForCandidates = new Map<string, number>();
  for (const row of await prisma.enrollment.findMany({
    where: { academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { classGroupId: true },
  })) {
    rosterForCandidates.set(row.classGroupId, (rosterForCandidates.get(row.classGroupId) ?? 0) + 1);
  }
  const candidates = await prisma.assessment.findMany({
    where: { termId: term.id },
    select: { id: true, status: true, classGroupId: true, scores: true },
  });
  const sheet = candidates.find(
    (a) =>
      a.scores.length >= 2 &&
      (a.status === "APPROVED" || a.scores.length >= (rosterForCandidates.get(a.classGroupId) ?? 0)),
  );
  if (!sheet) {
    console.log("  --   no finished, scored assessment to unfinish");
  } else {
    const scoreTotal = await prisma.score.count();
    const dropped = sheet.scores.slice(0, 2);
    await prisma.assessment.update({ where: { id: sheet.id }, data: { status: "OPEN" } });
    await prisma.score.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });

    const afterForce = baselineUnfinished + 1;
    const marking = (await ask()).find((i) => i.kind === "marking");
    check("an unfinished sheet raises marking", Boolean(marking), marking?.title ?? "(absent)");
    check(
      "it names the right count",
      marking?.title.startsWith(String(afterForce)) ?? false,
      `expected ${afterForce}, got "${marking?.title ?? "(absent)"}"`,
    );
    check("and points at the mark sheet", marking?.href === "/assessments/sheet", marking?.href ?? "");

    // Approval means finished, whatever the score count says.
    await prisma.assessment.update({ where: { id: sheet.id }, data: { status: "APPROVED" } });
    {
      const afterApprove = await unfinishedCount();
      const item = (await ask()).find((i) => i.kind === "marking");
      check(
        "an APPROVED sheet is never chased",
        afterApprove === baselineUnfinished &&
          (afterApprove === 0) === !item &&
          (!item || item.title.startsWith(String(afterApprove))),
        `${afterApprove} unfinished`,
      );
    }

    await prisma.assessment.update({ where: { id: sheet.id }, data: { status: sheet.status } });
    for (const s of dropped) {
      await prisma.score.create({
        data: {
          schoolId: s.schoolId,
          assessmentId: s.assessmentId,
          studentId: s.studentId,
          rawScore: s.rawScore,
          isAbsent: s.isAbsent,
          enteredByStaffId: s.enteredByStaffId,
        },
      });
    }
    {
      const afterRestore = await unfinishedCount();
      const item = (await ask()).find((i) => i.kind === "marking");
      check(
        "clears once the marks are back",
        afterRestore === baselineUnfinished &&
          (afterRestore === 0) === !item &&
          (!item || item.title.startsWith(String(afterRestore))),
        `${afterRestore} unfinished`,
      );
    }
    check("and every score is back", (await prisma.score.count()) === scoreTotal);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
