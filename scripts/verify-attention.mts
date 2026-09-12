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

// ── Half one: does it agree with a recount? ─────────────────────────────────
console.log("\nAgainst the database as it stands");
{
  const items = await ask();
  console.log(`  (${items.map((i) => i.tag).join(", ") || "nothing"})`);

  const enrolments = await prisma.enrollment.findMany({
    where: { academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { classGroupId: true },
  });
  const roster = new Map<string, number>();
  for (const row of enrolments) roster.set(row.classGroupId, (roster.get(row.classGroupId) ?? 0) + 1);

  const assessments = await prisma.assessment.findMany({
    where: { termId: term.id },
    select: { id: true, status: true, classGroupId: true, _count: { select: { scores: true } } },
  });
  const unfinished = assessments.filter(
    (a) => a.status !== "APPROVED" && a._count.scores < (roster.get(a.classGroupId) ?? 0),
  );
  const marking = items.find((i) => i.kind === "marking");
  check(
    "marking agrees with a recount",
    (unfinished.length === 0) === !marking &&
      (!marking || marking.title.startsWith(String(unfinished.length))),
    `${unfinished.length} unfinished`,
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

  const sheet = await prisma.assessment.findFirst({
    where: { termId: term.id },
    select: { id: true, status: true, scores: true },
  });
  if (!sheet || sheet.scores.length < 2) {
    console.log("  --   no scored assessment to unfinish");
  } else {
    const scoreTotal = await prisma.score.count();
    const dropped = sheet.scores.slice(0, 2);
    await prisma.assessment.update({ where: { id: sheet.id }, data: { status: "OPEN" } });
    await prisma.score.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });

    const marking = (await ask()).find((i) => i.kind === "marking");
    check("an unfinished sheet raises marking", Boolean(marking), marking?.title ?? "(absent)");
    check("it names one sheet", marking?.title.startsWith("1 sheet") ?? false, marking?.title ?? "");
    check("and points at the mark sheet", marking?.href === "/assessments/sheet", marking?.href ?? "");

    // Approval means finished, whatever the score count says.
    await prisma.assessment.update({ where: { id: sheet.id }, data: { status: "APPROVED" } });
    check("an APPROVED sheet is never chased", !(await ask()).find((i) => i.kind === "marking"));

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
    check("clears once the marks are back", !(await ask()).find((i) => i.kind === "marking"));
    check("and every score is back", (await prisma.score.count()) === scoreTotal);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
await prisma.$disconnect();
if (failed > 0) process.exitCode = 1;
