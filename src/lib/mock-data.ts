import "server-only";

import { prisma } from "@/lib/prisma";
import { aggregateChange, mockBroadsheet, type MockMark } from "@/lib/mock-engine";
import type { Band } from "@/lib/results-engine";

// Sequential queries, not Promise.all — see the connection_limit note in
// CLAUDE.md. A fan-out queues on the pooled connection and times out.

/**
 * The class that sits mocks: the top of the JHS ladder, the BECE year.
 *
 * Found by STAGE and ORDER, never by code — the GES provisioning names it "B9",
 * the demo seed "JHS3", and a school may rename either. Null for a school with
 * no JHS (a primary-only school has no candidates).
 */
export async function candidateLevel() {
  return prisma.level.findFirst({
    where: { stage: "JHS" },
    orderBy: { order: "desc" },
    select: { id: true, name: true },
  });
}

/** The scale term results use, so a mock "2" means what a report-card "2" means. */
async function gradingBands(): Promise<Band[]> {
  const settings = await prisma.schoolSettings.findFirst({ select: { defaultGradingScaleId: true } });
  const scale =
    (settings?.defaultGradingScaleId
      ? await prisma.gradingScale.findUnique({
          where: { id: settings.defaultGradingScaleId },
          include: { bands: true },
        })
      : null) ?? (await prisma.gradingScale.findFirst({ where: { isDefault: true }, include: { bands: true } }));
  return (scale?.bands ?? []).map((band) => ({
    grade: band.grade,
    minScore: band.minScore,
    maxScore: band.maxScore,
    points: band.points,
    remark: band.remark,
    isPass: band.isPass,
  }));
}

/** The subjects the level offers, in curriculum order. */
async function levelSubjects(levelId: string) {
  const links = await prisma.levelSubject.findMany({
    where: { levelId },
    orderBy: [{ order: "asc" }, { subject: { order: "asc" } }],
    select: { subject: { select: { id: true, code: true, name: true } } },
  });
  return links.map((link) => link.subject);
}

/**
 * Who sits a mock: every pupil ENROLLED in a class of the level for the mock's
 * year. Read from enrolments, as the register and results are, so a withdrawn
 * or deleted pupil drops out and a pupil moved between streams is not counted
 * twice.
 */
async function candidates(levelId: string, academicYearId: string, classGroupId?: string) {
  const roll = await prisma.enrollment.findMany({
    where: {
      academicYearId,
      status: "ACTIVE",
      classGroup: { levelId },
      ...(classGroupId ? { classGroupId } : {}),
      student: { deletedAt: null },
    },
    select: {
      classGroup: { select: { id: true, name: true } },
      student: { select: { id: true, firstName: true, lastName: true, admissionNo: true, gender: true } },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });
  return roll.map((row) => ({ ...row.student, classGroup: row.classGroup }));
}

/** The mocks of the current year, for the candidate level, oldest first. */
export async function getMockOverview() {
  const level = await candidateLevel();
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  if (!level || !year) {
    return { level, year, mocks: [], candidates: 0, subjects: 0 };
  }
  const mocks = await prisma.mockExam.findMany({
    where: { levelId: level.id, academicYearId: year.id },
    orderBy: [{ sittingDate: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { scores: true } } },
  });
  const roll = await candidates(level.id, year.id);
  const subjects = await levelSubjects(level.id);
  return { level, year, mocks, candidates: roll.length, subjects: subjects.length };
}

/** The level's classes and subjects, and which pairs this person may mark. */
export async function getMockSheetOptions(levelId: string, academicYearId: string, staffId: string | null, isLeadership: boolean) {
  const classGroups = await prisma.classGroup.findMany({
    where: { levelId },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
  const subjects = await levelSubjects(levelId);
  if (isLeadership) {
    return { classGroups, subjects, pairs: null };
  }
  const pairs = staffId
    ? await prisma.teachingAssignment.findMany({
        where: { staffId, academicYearId, classGroup: { levelId } },
        select: { classGroupId: true, subjectId: true },
      })
    : [];
  return { classGroups, subjects, pairs };
}

/** One class's sheet for one subject of a mock. */
export async function getMockSheet(mockExamId: string, academicYearId: string, levelId: string, classGroupId: string, subjectId: string) {
  const students = await candidates(levelId, academicYearId, classGroupId);
  const scores = await prisma.mockScore.findMany({
    where: { mockExamId, subjectId, studentId: { in: students.map((s) => s.id) } },
    select: { studentId: true, rawScore: true, isAbsent: true },
  });
  const bands = await gradingBands();
  return {
    students,
    scoreFor: Object.fromEntries(
      scores.map((s) => [s.studentId, { rawScore: s.rawScore === null ? null : String(s.rawScore), isAbsent: s.isAbsent }]),
    ),
    bands: bands.map((b) => ({ grade: b.grade, min: Number(b.minScore), max: Number(b.maxScore) })),
  };
}

async function marksFor(mockExamId: string, studentIds: string[]): Promise<MockMark[]> {
  const scores = await prisma.mockScore.findMany({
    where: { mockExamId, studentId: { in: studentIds } },
    select: { studentId: true, subjectId: true, rawScore: true, isAbsent: true },
  });
  return scores.map((s) => ({
    studentId: s.studentId,
    subjectId: s.subjectId,
    rawScore: s.rawScore === null ? null : Number(s.rawScore),
    isAbsent: s.isAbsent,
  }));
}

/**
 * A whole mock: every candidate of the level (positions are year-group wide,
 * as the BECE ranks candidates, not streams), optionally shown for one class.
 */
export async function getMockBroadsheet(mockExamId: string, classGroupId?: string) {
  const mock = await prisma.mockExam.findUnique({
    where: { id: mockExamId },
    include: { level: { select: { id: true, name: true } }, academicYear: { select: { id: true, name: true } } },
  });
  if (!mock) return null;

  const roll = await candidates(mock.levelId, mock.academicYearId);
  const subjects = await levelSubjects(mock.levelId);
  const bands = await gradingBands();
  const marks = await marksFor(mock.id, roll.map((s) => s.id));

  const sheet = mockBroadsheet({ subjects, studentIds: roll.map((s) => s.id), marks, bands });
  const student = new Map(roll.map((s) => [s.id, s]));
  const rows = sheet.rows
    .filter((row) => !classGroupId || student.get(row.studentId)?.classGroup.id === classGroupId)
    .map((row) => ({ ...row, student: student.get(row.studentId)! }));

  const classGroups = [...new Map(roll.map((s) => [s.classGroup.id, s.classGroup])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  return {
    mock,
    subjects: sheet.subjects,
    rows,
    classGroups,
    candidates: roll.length,
    hasScale: bands.length > 0,
  };
}

/** Each candidate's aggregate in every mock of the year, oldest mock first. */
export async function getMockProgress(classGroupId?: string) {
  const level = await candidateLevel();
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  if (!level || !year) return null;

  const mocks = await prisma.mockExam.findMany({
    where: { levelId: level.id, academicYearId: year.id },
    orderBy: [{ sittingDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, title: true },
  });
  const roll = await candidates(level.id, year.id);
  const subjects = await levelSubjects(level.id);
  const bands = await gradingBands();
  const ids = roll.map((s) => s.id);

  const byMock = new Map<string, Map<string, { aggregate: number | null; position: number | null }>>();
  for (const mock of mocks) {
    const { rows } = mockBroadsheet({ subjects, studentIds: ids, marks: await marksFor(mock.id, ids), bands });
    byMock.set(mock.id, new Map(rows.map((r) => [r.studentId, { aggregate: r.aggregate, position: r.position }])));
  }

  const rows = roll
    .filter((s) => !classGroupId || s.classGroup.id === classGroupId)
    .map((student) => {
      const results = mocks.map((mock) => byMock.get(mock.id)?.get(student.id) ?? { aggregate: null, position: null });
      return { student, results, change: aggregateChange(results.map((r) => r.aggregate)) };
    });

  const classGroups = [...new Map(roll.map((s) => [s.classGroup.id, s.classGroup])).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { level, year, mocks, rows, classGroups };
}
