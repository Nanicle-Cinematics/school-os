"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AssessmentType, Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { LEADERSHIP, MARK_ANY_CLASS, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { rosterWhere } from "@/lib/class-roster";
import { ownsSheet } from "@/lib/ownership";
import { checkScore, refusalMessage } from "@/lib/score-limits";

const ASSESSMENT_TYPES = Object.keys(AssessmentType);

export type AssessmentState = { error?: string; ok?: string };

/**
 * A teacher may only touch assessments for a class/subject they are assigned.
 * MARK_ANY_CLASS bypasses this: leadership, and the IT admin who keys in what
 * teachers hand over on paper. Checked server-side on every write — the UI
 * hiding a form is a convenience, not a control.
 */
async function assertMayTeach(
  auth: { roles: Parameters<typeof canAccess>[0]; staffId: string | null },
  classGroupId: string,
  subjectId: string,
) {
  if (canAccess(auth.roles, MARK_ANY_CLASS)) {
    return true;
  }
  if (!auth.staffId) {
    return false;
  }
  const count = await prisma.teachingAssignment.count({
    where: { staffId: auth.staffId, classGroupId, subjectId },
  });
  return count > 0;
}

/**
 * Record a new assessment for any class: MARK_ANY_CLASS, so the IT admin as well as
 * leadership (2026-10-13, on the school's request). The total it is marked out of is
 * chosen HERE, for a component that has no marks yet, which is different from
 * changing the total of one that has: that rescales every mark already entered and
 * stays LEADERSHIP on the mark sheet (`mayChangeTotals` in sheet-actions.ts).
 */
export async function createAssessment(
  _prev: AssessmentState,
  formData: FormData,
): Promise<AssessmentState> {
  const auth = await requireRole(MARK_ANY_CLASS);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const type = String(formData.get("type") ?? "CLASS_TEST");
  const title = String(formData.get("title") ?? "").trim();
  const maxScore = Number(formData.get("maxScore") ?? 100);
  const weight = Number(formData.get("weight") ?? 0);
  const dueDateRaw = String(formData.get("dueDate") ?? "");

  if (!termId || !classGroupId || !subjectId) {
    return { error: "Choose a term, class and subject." };
  }
  if (!title) {
    return { error: "Give the assessment a title, e.g. “Class Test 2”." };
  }
  if (!Number.isFinite(maxScore) || maxScore <= 0) {
    return { error: "Maximum score must be greater than zero." };
  }
  // ⚠️ BEFORE the teaching check, which leadership passes without reading
  // anything. An assessment is unique on (term, class, subject, title) with no
  // school in the index, so one on another school's ids would also stop that
  // school opening its own sheet for the title.
  if (!(await ownsSheet(termId, classGroupId, subjectId))) {
    return { error: "That term, class or subject was not found." };
  }
  if (!(await assertMayTeach(auth, classGroupId, subjectId))) {
    return { error: "You are not assigned to teach that subject in that class." };
  }
  if (!ASSESSMENT_TYPES.includes(type)) {
    return { error: "Choose what kind of assessment this is." };
  }
  if (maxScore > 1000) {
    return { error: "A component is marked out of 1000 at most." };
  }
  // A negative or runaway weight would skew every average it is part of.
  if (weight !== 0 && (!Number.isFinite(weight) || weight < 0 || weight > 1000)) {
    return { error: "The weight must be between 0 and 1000." };
  }
  const dueDate = dueDateRaw ? new Date(dueDateRaw) : null;
  if (dueDate && Number.isNaN(dueDate.getTime())) {
    return { error: "That due date is not valid." };
  }

  let created = "";
  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const assessment = await tx.assessment.create({
        data: {
          schoolId: auth.schoolId,
          termId,
          classGroupId,
          subjectId,
          type: type as "CLASS_TEST",
          title,
          maxScore: new Prisma.Decimal(maxScore),
          weight: new Prisma.Decimal(weight || 0),
          dueDate,
          status: "OPEN",
          createdByStaffId: auth.staffId,
        },
      });
      created = assessment.id;

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "assessment.create",
        entity: "Assessment",
        entityId: assessment.id,
        after: { title, type, maxScore, weight },
      });
    });
  } catch (error) {
    // One "Class Test 1" per class, subject and term (a unique index). Answered, rather than left
    // to surface as a server error on a form that has just been filled in. `redirect` below is
    // OUTSIDE this try: it works by throwing, and must not be caught here.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already an assessment called “${title}” for that class, subject and term. Choose another title.` };
    }
    throw error;
  }

  revalidatePath("/assessments");
  redirect(`/assessments/${created}`);
}

export type ScoreEntryState = { error?: string; ok?: string; savedAt?: string };

/**
 * Save a whole class's scores in one transaction.
 * Blank means "not marked yet" and deletes any existing row, which is different
 * from absent (zero). Conflating the two is how a student ends up with a zero
 * for a test the teacher simply hasn't got to.
 */
export async function saveScores(
  _prev: ScoreEntryState,
  formData: FormData,
): Promise<ScoreEntryState> {
  // MARK_ANY_CLASS, like the mark sheet: entering marks is not approving them.
  // Submitting, approving, unlocking and deleting stay LEADERSHIP below.
  const auth = await requireRole(MARK_ANY_CLASS);
  setTenantContext(auth.tenant);
  const assessmentId = String(formData.get("assessmentId") ?? "");

  const assessment = await prisma.assessment.findUnique({ where: { id: assessmentId } });
  if (!assessment) {
    return { error: "That assessment no longer exists." };
  }
  if (assessment.status === "APPROVED") {
    return { error: "These scores have been approved and can no longer be edited." };
  }

  // Only pupils on this class's roll, and nothing once the class's results are
  // published — the same two rules the mark sheet applies.
  const term = await prisma.term.findUnique({
    where: { id: assessment.termId },
    select: { academicYearId: true },
  });
  const roster = await prisma.enrollment.findMany({
    where: rosterWhere(term?.academicYearId ?? "", assessment.classGroupId),
    select: { studentId: true, student: { select: { firstName: true, lastName: true } } },
  });
  const enrolled = new Set(roster.map((row) => row.studentId));
  const names = new Map(roster.map((row) => [row.studentId, `${row.student.lastName} ${row.student.firstName}`]));
  const published = await prisma.termResult.count({
    where: { termId: assessment.termId, classGroupId: assessment.classGroupId, status: "PUBLISHED" },
  });
  if (published > 0) {
    return {
      error: "This class's results are already published, so the marks are locked. Withdraw the results first if a correction is needed.",
    };
  }
  if (!(await assertMayTeach(auth, assessment.classGroupId, assessment.subjectId))) {
    return { error: "You are not assigned to teach that subject in that class." };
  }

  // The total this assessment is marked out of, as persisted. Nothing in this action can change it.
  const max = Number(assessment.maxScore);
  const updates: { studentId: string; rawScore: number | null; isAbsent: boolean }[] = [];
  const problems: string[] = [];

  // The pupils the form NAMES, by a mark box or by an absent tick, either alone: a browser does not
  // submit a disabled input, so an absence must not depend on its mark box being sent (see saveSheet).
  const named = new Set<string>();
  for (const key of formData.keys()) {
    if (key.startsWith("score:") || key.startsWith("absent:")) {
      named.add(key.slice(key.indexOf(":") + 1));
    }
  }
  for (const studentId of named) {
    if (!enrolled.has(studentId)) {
      continue;
    }
    const raw = String(formData.get(`score:${studentId}`) ?? "").trim();
    const isAbsent = formData.get(`absent:${studentId}`) === "on";

    if (isAbsent) {
      updates.push({ studentId, rawScore: null, isAbsent: true });
      continue;
    }
    if (raw === "") {
      updates.push({ studentId, rawScore: null, isAbsent: false });
      continue;
    }

    const verdict = checkScore(raw, max);
    if (!verdict.ok || verdict.value === null) {
      problems.push(`${names.get(studentId) ?? "A pupil"}: ${verdict.ok ? "not a mark" : verdict.reason}`);
      continue;
    }
    updates.push({ studentId, rawScore: verdict.value, isAbsent: false });
  }
  // Refused as a whole, before anything is written: a half-saved class is worse than an unsaved one.
  if (problems.length > 0) {
    return { error: refusalMessage(problems) };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
      for (const update of updates) {
        if (update.rawScore === null && !update.isAbsent) {
          await tx.score.deleteMany({ where: { assessmentId, studentId: update.studentId } });
          continue;
        }
        const data = {
          schoolId: auth.schoolId,
          assessmentId,
          studentId: update.studentId,
          rawScore: update.rawScore === null ? null : new Prisma.Decimal(update.rawScore),
          isAbsent: update.isAbsent,
          enteredByStaffId: auth.staffId,
        };
        await tx.score.upsert({
          where: { assessmentId_studentId: { assessmentId, studentId: update.studentId } },
          create: data,
          update: data,
        });
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "score.saveBatch",
        entity: "Assessment",
        entityId: assessmentId,
        after: {
          entered: updates.filter((u) => u.rawScore !== null).length,
          absent: updates.filter((u) => u.isAbsent).length,
          cleared: updates.filter((u) => u.rawScore === null && !u.isAbsent).length,
        },
      });
    },
    { timeout: 60_000, maxWait: 20_000 },
  );

  revalidatePath(`/assessments/${assessmentId}`);
  return {
    ok: `Saved ${updates.filter((u) => u.rawScore !== null || u.isAbsent).length} scores.`,
    savedAt: new Date().toISOString(),
  };
}

/**
 * Move an assessment along. MARK_ANY_CLASS may SUBMIT one for review (OPEN to SUBMITTED), which is the
 * IT admin handing what they recorded to a head. Everything else is LEADERSHIP's sign-off: approve,
 * send back, unlock. The gate is `requireRole(MARK_ANY_CLASS)` and the narrowing is the one check
 * below, so a request that is not exactly OPEN to SUBMITTED from anyone else does nothing, whatever
 * the form was forged to say.
 */
export async function setAssessmentStatus(formData: FormData): Promise<void> {
  const auth = await requireRole(MARK_ANY_CLASS);
  setTenantContext(auth.tenant);
  const assessmentId = String(formData.get("assessmentId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!assessmentId || !["OPEN", "SUBMITTED", "APPROVED"].includes(status)) {
    return;
  }
  const isLeadership = canAccess(auth.roles, LEADERSHIP);

  await tenantTransaction(auth.schoolId, async (tx) => {
    const before = await tx.assessment.findUnique({ where: { id: assessmentId } });
    if (!before) {
      return;
    }
    // Anyone who is not leadership may only submit an assessment that is still open.
    if (!isLeadership && !(before.status === "OPEN" && status === "SUBMITTED")) {
      return;
    }
    // Reopening an approved assessment behind a published report card would let
    // its marks drift from the card; withdraw the results first.
    if (before.status === "APPROVED" && status !== "APPROVED") {
      const published = await tx.termResult.count({
        where: { termId: before.termId, classGroupId: before.classGroupId, status: "PUBLISHED" },
      });
      if (published > 0) {
        return;
      }
    }
    await tx.assessment.update({
      where: { id: assessmentId },
      data: { status: status as "OPEN" },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "assessment.status",
      entity: "Assessment",
      entityId: assessmentId,
      before: { status: before.status },
      after: { status },
    });
  });

  revalidatePath("/assessments");
  revalidatePath(`/assessments/${assessmentId}`);
}

// LEADERSHIP only: deleting takes every mark entered against the assessment with it.
export async function deleteAssessment(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);
  const assessmentId = String(formData.get("assessmentId") ?? "");
  if (!assessmentId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const assessment = await tx.assessment.findUnique({
      where: { id: assessmentId },
      include: { _count: { select: { scores: true } } },
    });
    if (!assessment || assessment.status === "APPROVED") {
      return;
    }
    await tx.assessment.delete({ where: { id: assessmentId } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "assessment.delete",
      entity: "Assessment",
      entityId: assessmentId,
      before: { title: assessment.title, scores: assessment._count.scores },
    });
  });

  revalidatePath("/assessments");
  redirect("/assessments");
}
