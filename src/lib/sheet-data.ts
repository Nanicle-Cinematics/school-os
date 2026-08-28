import "server-only";

import { prisma } from "@/lib/prisma";
import { isExamType } from "@/lib/assessment-templates";

/**
 * One class's mark sheet for one subject: the components across, the students
 * down, and every score already entered.
 *
 * Sequential queries, not Promise.all — see the connection_limit note in
 * CLAUDE.md. A fan-out here queues on the single pooled connection and times
 * out before it returns.
 */
export async function getSheet(termId: string, classGroupId: string, subjectId: string) {
  const assessments = await prisma.assessment.findMany({
    where: { termId, classGroupId, subjectId },
    orderBy: [{ type: "asc" }, { title: "asc" }],
    include: { scores: { select: { studentId: true, rawScore: true, isAbsent: true } } },
  });

  const students = await prisma.student.findMany({
    where: { currentClassGroupId: classGroupId, status: "ACTIVE", deletedAt: null },
    select: { id: true, firstName: true, lastName: true, admissionNo: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const settings = await prisma.schoolSettings.findFirst({
    select: { classScoreWeight: true, examScoreWeight: true },
  });

  // Exam last, then by the order a school would mark them in. The template's
  // order column is not on Assessment, so title carries it — "Class Test 1"
  // before "Class Test 2" — with exams pushed to the end regardless.
  const columns = [...assessments].sort((a, b) => {
    const examA = isExamType(a.type) ? 1 : 0;
    const examB = isExamType(b.type) ? 1 : 0;
    if (examA !== examB) return examA - examB;
    return a.title.localeCompare(b.title);
  });

  const scoreFor = new Map<string, { rawScore: string | null; isAbsent: boolean }>();
  for (const assessment of assessments) {
    for (const score of assessment.scores) {
      scoreFor.set(`${assessment.id}:${score.studentId}`, {
        rawScore: score.rawScore === null ? null : String(score.rawScore),
        isAbsent: score.isAbsent,
      });
    }
  }

  return {
    columns: columns.map((column) => ({
      id: column.id,
      title: column.title,
      type: column.type,
      maxScore: Number(column.maxScore),
      isExam: isExamType(column.type),
      status: column.status,
      marked: column.scores.filter((s) => s.rawScore !== null || s.isAbsent).length,
    })),
    students,
    scoreFor,
    classWeight: settings?.classScoreWeight ?? 30,
    examWeight: settings?.examScoreWeight ?? 70,
  };
}

/** The class list with whatever pastoral fields have been filled in so far. */
export async function getClassRemarks(termId: string, classGroupId: string) {
  const students = await prisma.student.findMany({
    where: { currentClassGroupId: classGroupId, status: "ACTIVE", deletedAt: null },
    select: { id: true, firstName: true, lastName: true, admissionNo: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  const results = await prisma.termResult.findMany({
    where: { termId, studentId: { in: students.map((s) => s.id) } },
    select: {
      studentId: true,
      conduct: true,
      attitude: true,
      interest: true,
      formTeacherRemark: true,
      headRemark: true,
      daysPresent: true,
      daysTotal: true,
      status: true,
    },
  });

  const byStudent = new Map(results.map((r) => [r.studentId, r]));
  return {
    students,
    byStudent,
    // A published card is already out; editing it silently would change what a
    // parent was told.
    published: results.filter((r) => r.status === "PUBLISHED").length,
  };
}

/** Terms, and the class/subject pairs this person is allowed to mark. */
export async function getSheetOptions(auth: {
  staffId: string | null;
  isLeadership: boolean;
}) {
  const terms = await prisma.term.findMany({
    orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
    include: { academicYear: { select: { name: true } } },
    take: 12,
  });

  if (auth.isLeadership) {
    const classGroups = await prisma.classGroup.findMany({
      orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
      include: { level: { select: { name: true } } },
    });
    const subjects = await prisma.subject.findMany({ orderBy: { order: "asc" } });
    return { terms, classGroups, subjects, pairs: null };
  }

  // Current year only. The pickers must agree with `mayTeach`, or a teacher is
  // offered a class the save will then refuse.
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  const assignments = await prisma.teachingAssignment.findMany({
    where: { staffId: auth.staffId ?? "", academicYearId: year?.id ?? "" },
    include: {
      classGroup: { include: { level: { select: { name: true, order: true } } } },
      subject: true,
    },
  });

  return {
    terms,
    classGroups: [...new Map(assignments.map((a) => [a.classGroupId, a.classGroup])).values()],
    subjects: [...new Map(assignments.map((a) => [a.subjectId, a.subject])).values()],
    pairs: assignments.map((a) => ({ classGroupId: a.classGroupId, subjectId: a.subjectId })),
  };
}

export async function getAssessmentTemplates() {
  return prisma.assessmentTemplate.findMany({ orderBy: { order: "asc" } });
}
