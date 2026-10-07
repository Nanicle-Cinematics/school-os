import "server-only";

import { prisma } from "@/lib/prisma";
import { assembleCumulativeRecord } from "@/lib/cumulative";

const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));

/**
 * Everything the JHS cumulative record prints, for one pupil.
 *
 * Returns `{ jhs: false }` for a pupil who has never been in JHS — the sheet is
 * a JHS document, and nine empty columns for a Basic 4 child would read as a
 * record lost rather than one that does not exist yet.
 *
 * Sequential awaits, not Promise.all — see the connection_limit note in
 * CLAUDE.md.
 */
export async function getCumulativeRecord(studentId: string) {
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      schoolId: true,
      firstName: true,
      middleName: true,
      lastName: true,
      admissionNo: true,
      dateOfBirth: true,
      gender: true,
      deletedAt: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true, order: true, stage: true } } } },
    },
  });
  if (!student || student.deletedAt) {
    return null;
  }

  // Scoped to the pupil's school explicitly, not by row security alone: a
  // database holding several schools (any development one does) otherwise
  // hands back every school's JHS ladder, and the sheet prints each level
  // twice — once as the pupil's year and once as "not recorded".
  const levels = await prisma.level.findMany({
    where: { schoolId: student.schoolId, stage: "JHS" },
    select: { id: true, name: true, order: true },
  });
  const levelIds = levels.map((l) => l.id);

  const enrolments = await prisma.enrollment.findMany({
    where: { studentId, status: { not: "WITHDRAWN" }, classGroup: { levelId: { in: levelIds } } },
    select: {
      academicYear: { select: { id: true, name: true, startDate: true } },
      classGroup: { select: { name: true, level: { select: { id: true, name: true, order: true } } } },
    },
  });

  const inJhsNow = student.currentClassGroup?.level.stage === "JHS";
  if (!inJhsNow && enrolments.length === 0) {
    return { jhs: false as const, student };
  }

  const yearIds = enrolments.map((e) => e.academicYear.id);
  const terms = await prisma.term.findMany({
    where: { academicYearId: { in: yearIds } },
    select: { id: true, academicYearId: true, sequence: true },
  });
  const termIds = terms.map((t) => t.id);

  const termResults = await prisma.termResult.findMany({
    where: { studentId, termId: { in: termIds } },
    select: {
      termId: true,
      totalMarks: true,
      possibleMarks: true,
      percentage: true,
      classPosition: true,
      classSize: true,
      status: true,
      source: true,
    },
  });
  const subjectResults = await prisma.subjectResult.findMany({
    where: { studentId, termId: { in: termIds } },
    select: { termId: true, subjectId: true, totalScore: true, grade: true },
  });

  // The rows: what the JHS curriculum offers, plus anything that carries a
  // result — a subject dropped from the curriculum since must still print the
  // marks the child earned in it.
  const offered = await prisma.levelSubject.findMany({
    where: { levelId: { in: levelIds }, isElective: false },
    select: { subjectId: true },
  });
  const subjectIds = [...new Set([...offered.map((o) => o.subjectId), ...subjectResults.map((r) => r.subjectId)])];
  const subjects = await prisma.subject.findMany({
    where: { id: { in: subjectIds } },
    select: { id: true, name: true, order: true },
  });

  const settings = await prisma.schoolSettings.findFirst({
    where: { schoolId: student.schoolId },
    select: { showClassPosition: true },
  });

  const record = assembleCumulativeRecord({
    levels,
    currentLevelOrder: inJhsNow ? (student.currentClassGroup?.level.order ?? null) : null,
    enrolments,
    terms,
    termResults: termResults.map((r) => ({
      ...r,
      totalMarks: num(r.totalMarks),
      percentage: num(r.percentage),
    })),
    subjectResults: subjectResults.map((r) => ({ ...r, totalScore: num(r.totalScore) })),
    subjects,
  });

  return {
    jhs: true as const,
    student,
    record,
    showClassPosition: settings?.showClassPosition ?? true,
  };
}
