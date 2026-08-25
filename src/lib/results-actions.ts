"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { ACADEMIC, LEADERSHIP, canAccess } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { computeClassResults } from "@/lib/results-engine";
import { writeAudit } from "@/lib/audit";

export type ComputeState = { error?: string; ok?: string };

export async function computeResults(
  _prev: ComputeState,
  formData: FormData,
): Promise<ComputeState> {
  const auth = await requireRole(ACADEMIC);
  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");

  if (!termId || !classGroupId) {
    return { error: "Choose a term and a class." };
  }

  const result = await tenantTransaction(
    async (tx) => {
      const computed = await computeClassResults(tx, auth.schoolId, termId, classGroupId);
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "results.compute",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { termId, ...computed },
      });
      return computed;
    },
    { timeout: 180_000, maxWait: 30_000 },
  );

  revalidatePath("/results");

  if (result.students === 0) {
    return { error: "That class has no active enrolments." };
  }
  if (result.subjects === 0) {
    return {
      error: "No assessments found for that class this term — create assessments and enter scores first.",
    };
  }

  return {
    ok: `Computed ${result.subjects} subject${result.subjects === 1 ? "" : "s"} for ${result.students} students.`,
  };
}

/**
 * Move a whole class's results through the approval chain.
 * DRAFT → SUBMITTED (teacher) → APPROVED (leadership) → PUBLISHED (leadership).
 * Publishing is what makes a report card visible to parents, so it is the one
 * step that freezes the numbers.
 */
export async function setResultsStatus(formData: FormData): Promise<void> {
  const auth = await requireRole(ACADEMIC);
  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!termId || !classGroupId) {
    return;
  }
  if (!["DRAFT", "SUBMITTED", "APPROVED", "PUBLISHED"].includes(status)) {
    return;
  }
  if ((status === "APPROVED" || status === "PUBLISHED") && !canAccess(auth.roles, LEADERSHIP)) {
    return;
  }

  await tenantTransaction(async (tx) => {
    const updated = await tx.termResult.updateMany({
      where: { termId, classGroupId },
      data: {
        status: status as "DRAFT",
        publishedAt: status === "PUBLISHED" ? new Date() : null,
      },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "results.status",
      entity: "ClassGroup",
      entityId: classGroupId,
      after: { termId, status, affected: updated.count },
    });
  });

  revalidatePath("/results");
}

/** Form-master and head remarks, saved per student from the broadsheet. */
export async function saveRemarks(formData: FormData): Promise<void> {
  const auth = await requireRole(ACADEMIC);
  const termId = String(formData.get("termId") ?? "");
  const studentId = String(formData.get("studentId") ?? "");
  if (!termId || !studentId) {
    return;
  }

  const isLeadership = canAccess(auth.roles, LEADERSHIP);
  const formTeacherRemark = String(formData.get("formTeacherRemark") ?? "").trim();
  const headRemark = String(formData.get("headRemark") ?? "").trim();
  const conduct = String(formData.get("conduct") ?? "").trim();
  const attitude = String(formData.get("attitude") ?? "").trim();
  const interest = String(formData.get("interest") ?? "").trim();
  const daysPresentRaw = String(formData.get("daysPresent") ?? "");
  const daysTotalRaw = String(formData.get("daysTotal") ?? "");

  await tenantTransaction(async (tx) => {
    await tx.termResult.update({
      where: { termId_studentId: { termId, studentId } },
      data: {
        formTeacherRemark: formTeacherRemark || null,
        // Only leadership writes the head's remark.
        ...(isLeadership ? { headRemark: headRemark || null } : {}),
        conduct: conduct || null,
        attitude: attitude || null,
        interest: interest || null,
        daysPresent: daysPresentRaw ? Number(daysPresentRaw) : null,
        daysTotal: daysTotalRaw ? Number(daysTotalRaw) : null,
      },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "results.remarks",
      entity: "TermResult",
      entityId: `${termId}:${studentId}`,
      after: { hasFormRemark: Boolean(formTeacherRemark), hasHeadRemark: Boolean(headRemark) },
    });
  });

  revalidatePath(`/results/${studentId}`);
}
