"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { MARKING, LEADERSHIP, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { computeClassResults } from "@/lib/results-engine";
import { writeAudit } from "@/lib/audit";
import { textResultsPublished } from "@/lib/transactional-sms";

export type ComputeState = { error?: string; ok?: string };

export async function computeResults(
  _prev: ComputeState,
  formData: FormData,
): Promise<ComputeState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);
  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");

  if (!termId || !classGroupId) {
    return { error: "Choose a term and a class." };
  }

  const result = await tenantTransaction(auth.schoolId, async (tx) => {
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

  const promotion = result.promotion;
  const verdict =
    promotion && promotion.evaluated > 0
      ? ` Year totals decided: ${promotion.promoted} promoted, ${promotion.repeated} repeating${
          promotion.graduated > 0 ? `, ${promotion.graduated} graduating` : ""
        } at a ${promotion.passMark}% pass.`
      : "";

  return {
    ok: `Computed ${result.subjects} subject${result.subjects === 1 ? "" : "s"} for ${result.students} students.${verdict}`,
  };
}

/**
 * Move a whole class's results through the approval chain.
 * DRAFT → SUBMITTED (teacher) → APPROVED (leadership) → PUBLISHED (leadership).
 * Publishing is what makes a report card visible to parents, so it is the one
 * step that freezes the numbers.
 */
export async function setResultsStatus(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);
  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!termId || !classGroupId) {
    return;
  }
  if (!["DRAFT", "SUBMITTED", "APPROVED", "PUBLISHED"].includes(status)) {
    return;
  }

  const newlyPublished = await tenantTransaction(auth.schoolId, async (tx) => {
    /**
     * Who this run actually publishes, read BEFORE the update.
     *
     * Publishing is idempotent and a head may press it again — after a late
     * correction, or simply twice. The text that goes out must not be: a second
     * "your child's report is ready" is a second bill to the school and a
     * confusing message to the parent, so only rows that were not already
     * PUBLISHED are told about.
     */
    const publishing =
      status === "PUBLISHED"
        ? await tx.termResult.findMany({
            // Never published before: withdrawing and re-publishing a class to
            // fix a typo must not text every parent a second time.
            where: { termId, classGroupId, status: { not: "PUBLISHED" }, publishedAt: null },
            select: { studentId: true },
          })
        : [];

    const updated = await tx.termResult.updateMany({
      where: { termId, classGroupId },
      data: {
        status: status as "DRAFT",
        // Kept when a class is withdrawn, so "first published" survives a correction.
      },
    });
    if (status === "PUBLISHED") {
      await tx.termResult.updateMany({
        where: { termId, classGroupId, publishedAt: null },
        data: { publishedAt: new Date() },
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "results.status",
      entity: "ClassGroup",
      entityId: classGroupId,
      after: { termId, status, affected: updated.count },
    });

    return publishing.map((r) => r.studentId);
  });

  // After the commit, and best-effort: a gateway that is down must not undo a
  // publication. Obeys Settings → SMS, which until now promised this and did
  // nothing.
  if (status === "PUBLISHED") {
    await textResultsPublished({
      schoolId: auth.schoolId,
      schoolName: auth.schoolName,
      termId,
      studentIds: newlyPublished,
    });
  }

  revalidatePath("/results");
}

/** Form-master and head remarks, saved per student from the broadsheet. */
export async function saveRemarks(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);
  const termId = String(formData.get("termId") ?? "");
  const studentId = String(formData.get("studentId") ?? "");
  if (!termId || !studentId) {
    return;
  }

  // requireRole(LEADERSHIP) above already guarantees this; the head's remark is
  // written unconditionally.
  const formTeacherRemark = String(formData.get("formTeacherRemark") ?? "").trim();
  const headRemark = String(formData.get("headRemark") ?? "").trim();
  const conduct = String(formData.get("conduct") ?? "").trim();
  const attitude = String(formData.get("attitude") ?? "").trim();
  const interest = String(formData.get("interest") ?? "").trim();
  const daysPresentRaw = String(formData.get("daysPresent") ?? "");
  const daysTotalRaw = String(formData.get("daysTotal") ?? "");

  const daysPresent = daysPresentRaw ? Number(daysPresentRaw) : null;
  const daysTotal = daysTotalRaw ? Number(daysTotalRaw) : null;
  const badDays = (n: number | null) => n !== null && (!Number.isInteger(n) || n < 0);
  if (badDays(daysPresent) || badDays(daysTotal)) {
    return;
  }
  if (daysPresent !== null && daysTotal !== null && daysPresent > daysTotal) {
    return;
  }

  // No result row yet (results not computed) is "nothing to write to", not a crash.
  const exists = await prisma.termResult.count({ where: { termId, studentId } });
  if (exists === 0) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.termResult.update({
      where: { termId_studentId: { termId, studentId } },
      data: {
        formTeacherRemark: formTeacherRemark || null,
        headRemark: headRemark || null,
        conduct: conduct || null,
        attitude: attitude || null,
        interest: interest || null,
        daysPresent,
        daysTotal,
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

/**
 * Conduct, attitude, interest, attendance and the form teacher's remark for a
 * whole class in one save.
 *
 * `saveRemarks` writes one student at a time from their own page, which for a
 * class of forty is forty page visits — so in practice these fields stayed
 * empty and the report card printed a row of dashes. This also works BEFORE
 * results are computed, because a form teacher fills this in over the term,
 * not in the scramble after marking.
 *
 * The head's remark is deliberately absent: it stays per-student and
 * leadership-only, since it is the one line on the card that should not be
 * written in bulk.
 */
export async function saveClassRemarks(
  _prev: { error?: string; ok?: string },
  formData: FormData,
): Promise<{ error?: string; ok?: string }> {
  const auth = await requireRole(MARKING);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  if (!termId || !classGroupId) {
    return { error: "Choose a term and class." };
  }

  const term = await prisma.term.findUnique({
    where: { id: termId },
    select: { academicYearId: true },
  });
  if (!term) {
    return { error: "That term does not exist." };
  }

  // A teacher may write remarks for a class they teach anything in; leadership
  // for any class. Subject-level assignment is too narrow here — the form
  // teacher writes the remark, and they may not teach every subject.
  if (!canAccess(auth.roles, LEADERSHIP)) {
    if (!auth.staffId) {
      return { error: "Your account is not linked to a staff record." };
    }
    const teaches = await prisma.teachingAssignment.count({
      where: { staffId: auth.staffId, classGroupId, academicYearId: term.academicYearId },
    });
    if (teaches === 0) {
      return { error: "You do not teach in that class." };
    }
  }

  type Row = {
    studentId: string;
    conduct: string | null;
    attitude: string | null;
    interest: string | null;
    formTeacherRemark: string | null;
    daysPresent: number | null;
    daysTotal: number | null;
  };

  const text = (key: string) => {
    const value = String(formData.get(key) ?? "").trim();
    return value ? value.slice(0, 300) : null;
  };

  // Only pupils actually on this class's roll — a forged `row:` key must not
  // reach another class's report card.
  const roster = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  const enrolled = new Set(roster.map((row) => row.studentId));

  const studentIds = [...formData.keys()]
    .filter((key) => key.startsWith("row:"))
    .map((key) => key.slice("row:".length))
    .filter((id) => enrolled.has(id));

  // A published card is settled; its remarks and conduct stay as they were read.
  const settled = new Set(
    (
      await prisma.termResult.findMany({
        where: { termId, studentId: { in: studentIds }, status: "PUBLISHED" },
        select: { studentId: true },
      })
    ).map((row) => row.studentId),
  );
  const writable = studentIds.filter((id) => !settled.has(id));

  const rows: Row[] = [];
  for (const studentId of writable) {
    const presentRaw = String(formData.get(`daysPresent:${studentId}`) ?? "").trim();
    const totalRaw = String(formData.get(`daysTotal:${studentId}`) ?? "").trim();
    const daysPresent = presentRaw ? Number(presentRaw) : null;
    const daysTotal = totalRaw ? Number(totalRaw) : null;

    if (daysPresent !== null && (!Number.isInteger(daysPresent) || daysPresent < 0)) {
      return { error: "Days present must be a whole number." };
    }
    if (daysTotal !== null && (!Number.isInteger(daysTotal) || daysTotal < 0)) {
      return { error: "Days in term must be a whole number." };
    }
    if (daysPresent !== null && daysTotal !== null && daysPresent > daysTotal) {
      return { error: "A student cannot be present for more days than the term has." };
    }

    rows.push({
      studentId,
      conduct: text(`conduct:${studentId}`),
      attitude: text(`attitude:${studentId}`),
      interest: text(`interest:${studentId}`),
      formTeacherRemark: text(`formTeacherRemark:${studentId}`),
      daysPresent,
      daysTotal,
    });
  }

  if (rows.length === 0) {
    return {
      error: settled.size > 0 ? "Those report cards are published, so they are locked." : "Nothing to save.",
    };
  }

  /**
   * Once the register is being taken, it owns the attendance figures.
   *
   * These two fields were hand-typed before the attendance module existed and
   * the inputs are still on screen for a school that has not started marking.
   * For a class that HAS, a stale number in a form field would silently
   * overwrite the derived one on save — the teacher would not even have
   * touched it. So the class is asked, and the typed values are dropped.
   */
  const registerTaken = await prisma.attendanceDay.count({
    where: { termId, classGroupId },
  });
  const derived = registerTaken > 0;

  let written = 0;
  await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      for (const row of rows) {
        const { studentId, daysPresent, daysTotal, ...rest } = row;
        const fields = derived ? rest : { ...rest, daysPresent, daysTotal };
        // upsert, not update: these are written during the term, before
        // computeResults has created any TermResult row to update.
        await tx.termResult.upsert({
          where: { termId_studentId: { termId, studentId } },
          create: { schoolId: auth.schoolId, termId, studentId, classGroupId, ...fields },
          update: fields,
        });
        written += 1;
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "results.classRemarks",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { termId, students: written, attendanceFromRegister: derived },
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  revalidatePath("/results/remarks");
  const note = derived ? " Attendance comes from the register and was left alone." : "";
  return { ok: `Saved for ${written} student${written === 1 ? "" : "s"}.${note}` };
}
