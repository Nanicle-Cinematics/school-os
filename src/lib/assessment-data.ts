import "server-only";

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/auth";
import { canAccess, LEADERSHIP } from "@/lib/permissions";

/**
 * Classes and subjects the signed-in user may enter scores for.
 * Leadership sees everything; a teacher sees only their own assignments, which
 * is what stops one teacher marking another's subject.
 */
export async function getTeachingScope(auth: AuthContext) {
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  if (isLeadership || !auth.staffId) {
    const [classGroups, subjects] = await Promise.all([
      prisma.classGroup.findMany({
        orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
        include: { level: { select: { name: true, order: true } } },
      }),
      prisma.subject.findMany({ orderBy: { order: "asc" } }),
    ]);
    return { isLeadership: true, classGroups, subjects, pairs: null };
  }

  const assignments = await prisma.teachingAssignment.findMany({
    where: { staffId: auth.staffId },
    include: {
      classGroup: { include: { level: { select: { name: true, order: true } } } },
      subject: true,
    },
  });

  const classGroups = [...new Map(assignments.map((a) => [a.classGroupId, a.classGroup])).values()];
  const subjects = [...new Map(assignments.map((a) => [a.subjectId, a.subject])).values()];

  return {
    isLeadership: false,
    classGroups,
    subjects,
    pairs: assignments.map((a) => ({ classGroupId: a.classGroupId, subjectId: a.subjectId })),
  };
}

export async function getAssessmentList(filters: {
  termId?: string;
  classGroupId?: string;
  subjectId?: string;
  allowedPairs: { classGroupId: string; subjectId: string }[] | null;
}) {
  return prisma.assessment.findMany({
    where: {
      ...(filters.termId ? { termId: filters.termId } : {}),
      ...(filters.classGroupId ? { classGroupId: filters.classGroupId } : {}),
      ...(filters.subjectId ? { subjectId: filters.subjectId } : {}),
      // A teacher only ever sees their own class/subject combinations.
      ...(filters.allowedPairs
        ? { OR: filters.allowedPairs.map((pair) => ({ ...pair })) }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }],
    take: 200,
    include: {
      subject: { select: { name: true, code: true } },
      classGroup: { include: { level: { select: { name: true } } } },
      term: { select: { sequence: true } },
      createdBy: { select: { firstName: true, lastName: true } },
      _count: { select: { scores: true } },
    },
  });
}

export async function getAssessmentForEntry(id: string) {
  const assessment = await prisma.assessment.findUnique({
    where: { id },
    include: {
      subject: true,
      term: { include: { academicYear: true } },
      classGroup: { include: { level: true } },
      scores: true,
    },
  });

  if (!assessment) {
    return null;
  }

  const enrolments = await prisma.enrollment.findMany({
    where: { classGroupId: assessment.classGroupId, status: "ACTIVE" },
    include: {
      student: {
        select: { id: true, firstName: true, lastName: true, admissionNo: true },
      },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });

  const scoreByStudent = new Map(assessment.scores.map((score) => [score.studentId, score]));

  return {
    assessment,
    rows: enrolments.map((enrolment) => ({
      student: enrolment.student,
      score: scoreByStudent.get(enrolment.studentId) ?? null,
    })),
  };
}

export async function getTermsForPicker() {
  return prisma.term.findMany({
    orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
    include: { academicYear: { select: { name: true } } },
    take: 12,
  });
}
