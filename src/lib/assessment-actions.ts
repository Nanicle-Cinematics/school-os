"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { AssessmentType, Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { LEADERSHIP, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

const ASSESSMENT_TYPES = Object.keys(AssessmentType);

export type AssessmentState = { error?: string; ok?: string };

/**
 * A teacher may only touch assessments for a class/subject they are assigned.
 * Leadership bypasses this. Checked server-side on every write — the UI hiding
 * a form is a convenience, not a control.
 */
async function assertMayTeach(
  auth: { roles: Parameters<typeof canAccess>[0]; staffId: string | null },
  classGroupId: string,
  subjectId: string,
) {
  if (canAccess(auth.roles, LEADERSHIP)) {
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

export async function createAssessment(
  _prev: AssessmentState,
  formData: FormData,
): Promise<AssessmentState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

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
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });
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
    where: {
      classGroupId: assessment.classGroupId,
      academicYearId: term?.academicYearId ?? "",
      status: "ACTIVE",
    },
    select: { studentId: true },
  });
  const enrolled = new Set(roster.map((row) => row.studentId));
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

  const max = Number(assessment.maxScore);
  const updates: { studentId: string; rawScore: number | null; isAbsent: boolean }[] = [];

  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("score:")) {
      continue;
    }
    const studentId = key.slice("score:".length);
    if (!enrolled.has(studentId)) {
      continue;
    }
    const raw = String(value).trim();
    const isAbsent = formData.get(`absent:${studentId}`) === "on";

    if (isAbsent) {
      updates.push({ studentId, rawScore: null, isAbsent: true });
      continue;
    }
    if (raw === "") {
      updates.push({ studentId, rawScore: null, isAbsent: false });
      continue;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      return { error: `“${raw}” is not a valid score.` };
    }
    if (parsed > max) {
      return { error: `Scores cannot exceed the maximum of ${max}.` };
    }
    updates.push({ studentId, rawScore: parsed, isAbsent: false });
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

export async function setAssessmentStatus(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });
  const assessmentId = String(formData.get("assessmentId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!assessmentId || !["OPEN", "SUBMITTED", "APPROVED"].includes(status)) {
    return;
  }
  // Only leadership may approve; a teacher can submit for review.

  await tenantTransaction(auth.schoolId, async (tx) => {
    const before = await tx.assessment.findUnique({ where: { id: assessmentId } });
    if (!before) {
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

export async function deleteAssessment(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });
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
