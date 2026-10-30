"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { ATTENDANCE, LEADERSHIP } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { parseDay } from "@/lib/attendance-data";
import { saveRegisterFor } from "@/lib/register-save";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { writeAudit } from "@/lib/audit";

export type RegisterState = { error?: string; ok?: string; savedAt?: string };

/** Mark, or re-mark, one class's register for one day. */
export async function saveRegister(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const auth = await requireRole(ATTENDANCE);
  setTenantContext(auth.tenant);

  const marks = new Map<string, string>();
  const notes = new Map<string, string>();
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (key.startsWith("mark:")) marks.set(key.slice(5), value);
    else if (key.startsWith("note:")) notes.set(key.slice(5), value);
  }

  // The form covers the whole roll ("all"): a child it does not mark loses any
  // earlier mark. The rules themselves live in register-save.ts, shared with
  // the offline sync route.
  const result = await saveRegisterFor(auth, {
    classGroupId: String(formData.get("classGroupId") ?? ""),
    dateRaw: String(formData.get("date") ?? ""),
    marks,
    notes,
    scope: "all",
  });
  if ("error" in result) {
    return { error: result.error };
  }

  revalidatePath("/attendance");
  revalidatePath("/results");
  return { ok: result.ok, savedAt: new Date().toISOString() };
}

/**
 * Delete a day's register.
 *
 * Needed because a register taken for the wrong class or the wrong date is
 * otherwise permanent, and it would go on counting against every child on it.
 * Office only: a teacher corrects marks, but removing a day's record of a whole
 * class is not a correction.
 */
export async function deleteRegister(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const classGroupId = String(formData.get("classGroupId") ?? "");
  const date = parseDay(String(formData.get("date") ?? ""));
  if (!classGroupId || !date) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const day = await tx.attendanceDay.findUnique({
      where: { classGroupId_date: { classGroupId, date } },
      select: { id: true, termId: true },
    });
    if (!day) {
      return;
    }

    // Entries cascade with the day.
    await tx.attendanceDay.delete({ where: { id: day.id } });
    // Recount without it, or the card keeps the deleted day in its denominator.
    await syncAttendanceTotals(tx, auth.schoolId, day.termId, classGroupId);

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "attendance.day.remove",
      entity: "ClassGroup",
      entityId: classGroupId,
      before: { date: String(formData.get("date")), termId: day.termId },
    });
  });

  revalidatePath("/attendance");
  revalidatePath("/results");
}
