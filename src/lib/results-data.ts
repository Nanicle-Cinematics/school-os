import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * The exact shapes a report card is rendered from.
 *
 * Shared so the single card and the whole-class print run render from identical
 * data — a bulk print that quietly differed from the one the office proof-read
 * would be the worst kind of bug, because nobody checks the other 39.
 */
export const REPORT_CARD_INCLUDE = {
  student: {
    include: {
      house: { select: { name: true } },
      guardians: { where: { isPrimary: true }, include: { guardian: true } },
    },
  },
  classGroup: {
    include: {
      level: true,
      formTeacher: { select: { firstName: true, lastName: true } },
    },
  },
  term: { include: { academicYear: true } },
} satisfies Prisma.TermResultInclude;

export const SUBJECT_RESULT_INCLUDE = {
  subject: { select: { name: true, code: true, order: true } },
  teacher: { select: { firstName: true, lastName: true } },
} satisfies Prisma.SubjectResultInclude;

export type ReportCardTermResult = Prisma.TermResultGetPayload<{
  include: typeof REPORT_CARD_INCLUDE;
}>;
export type ReportCardSubjectResult = Prisma.SubjectResultGetPayload<{
  include: typeof SUBJECT_RESULT_INCLUDE;
}>;
export type ReportCardSettings = Awaited<ReturnType<typeof prisma.schoolSettings.findFirst>>;

/** Broadsheet: every student in a class down the side, every subject across. */
export async function getBroadsheet(termId: string, classGroupId: string) {
  const [classGroup, term, results, termResults, subjects] = await Promise.all([
    prisma.classGroup.findUnique({
      where: { id: classGroupId },
      include: { level: true, formTeacher: { select: { firstName: true, lastName: true } } },
    }),
    prisma.term.findUnique({ where: { id: termId }, include: { academicYear: true } }),
    prisma.subjectResult.findMany({
      where: { termId, classGroupId },
      include: { subject: { select: { id: true, code: true, name: true, order: true } } },
    }),
    prisma.termResult.findMany({
      where: { termId, classGroupId },
      include: {
        student: {
          select: { id: true, firstName: true, lastName: true, admissionNo: true },
        },
      },
      orderBy: [{ classPosition: "asc" }],
    }),
    prisma.subject.findMany({ orderBy: { order: "asc" } }),
  ]);

  const usedSubjectIds = new Set(results.map((r) => r.subjectId));
  const columns = subjects.filter((subject) => usedSubjectIds.has(subject.id));

  const byStudent = new Map<string, Map<string, (typeof results)[number]>>();
  for (const result of results) {
    if (!byStudent.has(result.studentId)) {
      byStudent.set(result.studentId, new Map());
    }
    byStudent.get(result.studentId)!.set(result.subjectId, result);
  }

  return {
    classGroup,
    term,
    columns,
    rows: termResults.map((termResult) => ({
      termResult,
      scores: byStudent.get(termResult.studentId) ?? new Map(),
    })),
  };
}

/** Everything one report card needs. */
export async function getReportCard(termId: string, studentId: string) {
  const [termResult, subjectResults, settings] = await Promise.all([
    prisma.termResult.findUnique({
      where: { termId_studentId: { termId, studentId } },
      include: REPORT_CARD_INCLUDE,
    }),
    prisma.subjectResult.findMany({
      where: { termId, studentId },
      include: SUBJECT_RESULT_INCLUDE,
      orderBy: { subject: { order: "asc" } },
    }),
    prisma.schoolSettings.findFirst(),
  ]);

  if (!termResult) {
    return null;
  }

  return { termResult, subjectResults, settings };
}

export async function getResultsOverview(termId: string) {
  const classGroups = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    include: {
      level: { select: { name: true } },
      formTeacher: { select: { firstName: true, lastName: true } },
      _count: { select: { enrollments: { where: { status: "ACTIVE" } } } },
    },
  });

  const termResults = await prisma.termResult.groupBy({
    by: ["classGroupId", "status"],
    where: { termId },
    _count: true,
  });

  const assessments = await prisma.assessment.groupBy({
    by: ["classGroupId"],
    where: { termId, status: { not: "DRAFT" } },
    _count: true,
  });

  const assessmentCount = new Map(assessments.map((row) => [row.classGroupId, row._count]));

  return classGroups.map((classGroup) => {
    const rows = termResults.filter((row) => row.classGroupId === classGroup.id);
    const total = rows.reduce((sum, row) => sum + row._count, 0);
    const published = rows
      .filter((row) => row.status === "PUBLISHED")
      .reduce((sum, row) => sum + row._count, 0);
    const approved = rows
      .filter((row) => row.status === "APPROVED")
      .reduce((sum, row) => sum + row._count, 0);

    return {
      classGroup,
      enrolled: classGroup._count.enrollments,
      assessments: assessmentCount.get(classGroup.id) ?? 0,
      computed: total,
      approved,
      published,
    };
  });
}


/**
 * Every report card in a class, for printing in one run.
 *
 * Three queries whatever the class size — the per-student reader would be two
 * queries per child, and a form teacher printing forty of them on this
 * connection would be waiting minutes.
 */
export async function getClassReportCards(termId: string, classGroupId: string) {
  const termResults = await prisma.termResult.findMany({
    where: { termId, classGroupId },
    include: REPORT_CARD_INCLUDE,
    orderBy: [{ classPosition: "asc" }, { student: { lastName: "asc" } }],
  });

  const subjectResults = await prisma.subjectResult.findMany({
    where: { termId, classGroupId },
    include: SUBJECT_RESULT_INCLUDE,
    orderBy: { subject: { order: "asc" } },
  });

  const settings = await prisma.schoolSettings.findFirst();

  const byStudent = new Map<string, ReportCardSubjectResult[]>();
  for (const result of subjectResults) {
    byStudent.set(result.studentId, [...(byStudent.get(result.studentId) ?? []), result]);
  }

  return {
    settings,
    cards: termResults.map((termResult) => ({
      termResult,
      subjectResults: byStudent.get(termResult.studentId) ?? [],
    })),
  };
}
