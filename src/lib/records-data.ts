import "server-only";

import { prisma } from "@/lib/prisma";
import { rosterWhere } from "@/lib/class-roster";
import { isEarlierYear, proposeEarlierClass, yearsBack } from "@/lib/records-engine";

/**
 * The years and classes the records screens offer.
 *
 * Sequential awaits, not Promise.all — see the connection_limit note in
 * CLAUDE.md.
 */
export async function getRecordsContext() {
  const current = await prisma.academicYear.findFirst({
    where: { isCurrent: true },
    select: { id: true, name: true, startDate: true, endDate: true },
  });
  const years = await prisma.academicYear.findMany({
    select: { id: true, name: true, startDate: true, endDate: true },
    orderBy: { startDate: "desc" },
  });
  const earlier = years.filter((year) => isEarlierYear(year, current));

  const terms = earlier.length
    ? await prisma.term.findMany({
        where: { academicYearId: { in: earlier.map((y) => y.id) } },
        select: { id: true, name: true, sequence: true, academicYearId: true, academicYear: { select: { name: true, startDate: true } } },
      })
    : [];
  terms.sort(
    (a, b) =>
      b.academicYear.startDate.getTime() - a.academicYear.startDate.getTime() || a.sequence - b.sequence,
  );

  const classGroups = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, levelId: true, level: { select: { name: true, order: true } } },
  });

  return { current, years, earlier, terms, classGroups };
}

/**
 * Step one: which class each of today's pupils sat in, in an earlier year.
 *
 * The rows are a current class's roll; the default for each is the class it
 * already holds for that year, else the guess `proposeEarlierClass` makes from
 * the level ladder. `hasResults` marks a pupil whose placement is no longer free
 * to change, because records already hang off it.
 */
export async function getPlacementSheet(earlierYearId: string, classGroupId: string) {
  const context = await getRecordsContext();
  const { current, years, earlier, classGroups } = context;
  const year = earlier.find((y) => y.id === earlierYearId) ?? null;
  const classGroup = classGroups.find((c) => c.id === classGroupId) ?? null;
  if (!current || !year || !classGroup) {
    return { ...context, year, classGroup, rows: [], back: 0 };
  }

  const back = yearsBack(year, current, years);
  const proposal = proposeEarlierClass(classGroup, back, classGroups);

  const roll = await prisma.enrollment.findMany({
    where: rosterWhere(current.id, classGroupId),
    select: { student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } } },
  });
  const students = roll
    .map((r) => r.student)
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const ids = students.map((s) => s.id);

  const placed = await prisma.enrollment.findMany({
    where: { academicYearId: year.id, studentId: { in: ids } },
    select: { studentId: true, classGroupId: true },
  });
  const placedBy = new Map(placed.map((p) => [p.studentId, p.classGroupId]));

  const withResults = new Set(
    (
      await prisma.termResult.findMany({
        where: { studentId: { in: ids }, term: { academicYearId: year.id } },
        select: { studentId: true },
      })
    ).map((r) => r.studentId),
  );

  return {
    ...context,
    year,
    classGroup,
    back,
    rows: students.map((student) => ({
      student,
      savedClassGroupId: placedBy.get(student.id) ?? null,
      proposedClassGroupId: proposal,
      hasResults: withResults.has(student.id),
    })),
  };
}

/**
 * Step two: one subject's term figures for a class's roll in an earlier term.
 *
 * The roll is the term's own year (`rosterWhere`), so it is the children placed
 * in step one. A pupil already marked in School OS for this term is shown but
 * locked — the record must not overwrite what the engine computed.
 */
export async function getRecordsSheet(termId: string, classGroupId: string, subjectId: string) {
  const context = await getRecordsContext();
  const term = context.terms.find((t) => t.id === termId) ?? null;
  const classGroup = context.classGroups.find((c) => c.id === classGroupId) ?? null;

  const subjects = classGroup
    ? (
        await prisma.levelSubject.findMany({
          where: { levelId: classGroup.levelId },
          select: { subject: { select: { id: true, name: true, order: true } } },
        })
      )
        .map((ls) => ls.subject)
        .sort((a, b) => a.order - b.order)
    : [];
  const subject = subjects.find((s) => s.id === subjectId) ?? null;

  const settings = await prisma.schoolSettings.findFirst({
    select: { classScoreWeight: true, examScoreWeight: true },
  });
  const weights = { classWeight: settings?.classScoreWeight ?? 30, examWeight: settings?.examScoreWeight ?? 70 };

  if (!term || !classGroup || !subject) {
    return { ...context, term, classGroup, subjects, subject, weights, rows: [] };
  }

  const roll = await prisma.enrollment.findMany({
    where: rosterWhere(term.academicYearId, classGroupId),
    select: { student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } } },
  });
  const students = roll
    .map((r) => r.student)
    .sort((a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName));
  const ids = students.map((s) => s.id);

  const results = await prisma.subjectResult.findMany({
    where: { termId, subjectId, studentId: { in: ids } },
    select: { studentId: true, classScore: true, examScore: true, totalScore: true, grade: true, source: true },
  });
  const byStudent = new Map(results.map((r) => [r.studentId, r]));
  const computedTerm = new Set(
    (
      await prisma.termResult.findMany({
        where: {
          termId,
          studentId: { in: ids },
          source: "COMPUTED",
          OR: [{ totalMarks: { not: null } }, { status: "PUBLISHED" }],
        },
        select: { studentId: true },
      })
    ).map((r) => r.studentId),
  );

  const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

  return {
    ...context,
    term,
    classGroup,
    subjects,
    subject,
    weights,
    rows: students.map((student) => {
      const row = byStudent.get(student.id);
      return {
        student,
        classScore: num(row?.classScore),
        examScore: num(row?.examScore),
        totalScore: num(row?.totalScore),
        grade: row?.grade ?? null,
        locked: computedTerm.has(student.id) || row?.source === "COMPUTED",
      };
    }),
  };
}
