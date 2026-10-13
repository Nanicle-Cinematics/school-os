import "server-only";

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/lib/auth";
import { canAccess, MARK_ANY_CLASS } from "@/lib/permissions";
import { rosterWhere } from "@/lib/class-roster";

/**
 * Classes and subjects the signed-in user may enter scores for.
 * MARK_ANY_CLASS (leadership and the IT admin) sees and records for every class;
 * a teacher sees only their own assignments, which is what stops one teacher
 * marking another's subject.
 *
 * ⚠️ `seesWholeSchool` and `canRecord` are DIFFERENT questions. `canRecord` is
 * whether this person may create an assessment and enter its marks, and it is
 * what decides whether to SHOW a "New assessment" button and an editable grid.
 * Seeing every class is not permission to change one: submitting, approving,
 * unlocking and deleting (`setAssessmentStatus`, `deleteAssessment`) still
 * require LEADERSHIP, so a caller must not reuse `canRecord` to decide whether
 * to show those. It was once a single `isLeadership` field doing both jobs, and
 * offered an IT Admin a button that only redirected them away on click.
 *
 * It follows MARK_ANY_CLASS rather than "has no staff record", which is how an
 * IT Admin used to land in the whole-school branch by accident: one who also
 * holds a Staff row would have been scoped down to their own assignments.
 */
export async function getTeachingScope(auth: AuthContext) {
  const canRecord = canAccess(auth.roles, MARK_ANY_CLASS);

  if (canRecord || !auth.staffId) {
    const [classGroups, subjects] = await Promise.all([
      prisma.classGroup.findMany({
        orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
        include: { level: { select: { name: true, order: true } } },
      }),
      prisma.subject.findMany({ orderBy: { order: "asc" } }),
    ]);
    return { seesWholeSchool: true, canRecord, classGroups, subjects, pairs: null };
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
    seesWholeSchool: false,
    canRecord: false,
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
    // The term's own year's roll — see class-roster.ts.
    where: rosterWhere(assessment.term.academicYearId, assessment.classGroupId),
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
