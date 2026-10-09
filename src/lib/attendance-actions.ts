"use server";

import { revalidatePath } from "next/cache";
import type { AttendanceMark } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { ATTENDANCE, LEADERSHIP, OFFICE, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { parseDay, termForDate } from "@/lib/attendance-data";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { writeAudit } from "@/lib/audit";

export type RegisterState = { error?: string; ok?: string; savedAt?: string };

const MARKS: AttendanceMark[] = ["PRESENT", "LATE", "EXCUSED", "ABSENT"];

/**
 * A teacher marks the register of the class they FORM-TEACH, and no other; the
 * office marks any.
 *
 * Until 2026-10-09 a current-year teaching assignment was enough too, so a JHS
 * subject teacher who takes Mathematics in B7, B8 and B9 could take all three
 * registers, and the Basic 1 teacher could mark Basic 2. The school asked for
 * one class per teacher: the register is the form teacher's job, and a class
 * marked by whoever opened it first is a class whose absences nobody owns.
 *
 * This is the first WRITE a plain teacher makes against a class, which is why
 * it is checked here and not only by the page: /classes renders read-only for
 * them, and the register would otherwise be a hole in that.
 */
async function mayMark(
  auth: { roles: Parameters<typeof canAccess>[0]; staffId: string | null },
  classGroupId: string,
) {
  if (canAccess(auth.roles, OFFICE)) {
    return true;
  }
  if (!auth.staffId) {
    return false;
  }
  const isFormTeacher = await prisma.classGroup.count({
    where: { id: classGroupId, formTeacherId: auth.staffId },
  });
  return isFormTeacher > 0;
}

/** Mark, or re-mark, one class's register for one day. */
export async function saveRegister(
  _prev: RegisterState,
  formData: FormData,
): Promise<RegisterState> {
  const auth = await requireRole(ATTENDANCE);
  setTenantContext(auth.tenant);

  const classGroupId = String(formData.get("classGroupId") ?? "");
  const dateRaw = String(formData.get("date") ?? "");
  const date = parseDay(dateRaw);

  if (!classGroupId || !date) {
    return { error: "Choose a class and a date." };
  }

  // A register outside every term has nowhere to be counted, and a date typed
  // by hand is how it happens.
  const term = await termForDate(date);
  if (!term) {
    return {
      error: `${dateRaw} is not inside any term. Check the date, or set the term dates under Settings → Terms.`,
    };
  }

  if (!(await mayMark(auth, classGroupId))) {
    return { error: "Only the class's form teacher, or the office, takes its register." };
  }

  // The roll as it stands, so a mark cannot be posted for a child who is not
  // in the class — the form is a convenience, not the authority.
  const roster = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId: term.academicYearId, status: "ACTIVE" },
    select: { studentId: true },
  });
  const enrolled = new Set(roster.map((row) => row.studentId));

  if (enrolled.size === 0) {
    return { error: "Nobody is enrolled in that class this year." };
  }

  type Entry = { studentId: string; mark: AttendanceMark; note: string | null };
  const entries: Entry[] = [];
  let unmarked = 0;

  for (const studentId of enrolled) {
    const raw = String(formData.get(`mark:${studentId}`) ?? "");
    if (!raw) {
      // Left blank is "not marked", not "present". A register with holes in it
      // is the honest record of a register with holes in it.
      unmarked += 1;
      continue;
    }
    if (!MARKS.includes(raw as AttendanceMark)) {
      return { error: `“${raw}” is not a mark.` };
    }
    const note = String(formData.get(`note:${studentId}`) ?? "").trim();
    entries.push({
      studentId,
      mark: raw as AttendanceMark,
      // A reason belongs to an excused absence; carrying one on a present child
      // is noise the office would have to read past.
      note: raw === "EXCUSED" && note ? note.slice(0, 200) : null,
    });
  }

  if (entries.length === 0) {
    return { error: "Nobody has been marked yet." };
  }

  const counts = { present: 0, late: 0, excused: 0, absent: 0 };
  for (const entry of entries) {
    if (entry.mark === "PRESENT") counts.present += 1;
    else if (entry.mark === "LATE") counts.late += 1;
    else if (entry.mark === "EXCUSED") counts.excused += 1;
    else counts.absent += 1;
  }

  await tenantTransaction(
    auth.schoolId,
    async (tx) => {
      // One register per class per day: re-marking corrects the same day rather
      // than opening a second one, which is what makes an afternoon correction
      // safe and a double submit harmless.
      const day = await tx.attendanceDay.upsert({
        where: { classGroupId_date: { classGroupId, date } },
        create: {
          schoolId: auth.schoolId,
          termId: term.id,
          classGroupId,
          date,
          takenByStaffId: auth.staffId,
        },
        update: { takenByStaffId: auth.staffId },
      });

      for (const entry of entries) {
        const data = {
          schoolId: auth.schoolId,
          attendanceDayId: day.id,
          studentId: entry.studentId,
          mark: entry.mark,
          note: entry.note,
        };
        await tx.attendanceEntry.upsert({
          where: { attendanceDayId_studentId: { attendanceDayId: day.id, studentId: entry.studentId } },
          create: data,
          update: data,
        });
      }

      // A child removed from the mark set — unmarked after being marked — must
      // lose their entry, or yesterday's answer stands for a question nobody
      // answered today.
      await tx.attendanceEntry.deleteMany({
        where: { attendanceDayId: day.id, studentId: { notIn: entries.map((e) => e.studentId) } },
      });

      await syncAttendanceTotals(tx, auth.schoolId, term.id, classGroupId);

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "attendance.register",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: { date: dateRaw, termId: term.id, marked: entries.length, ...counts },
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  revalidatePath("/attendance");
  revalidatePath("/results");

  const absent = counts.absent + counts.excused;
  const tail = unmarked > 0 ? ` ${unmarked} left unmarked.` : "";
  return {
    ok:
      `Register saved — ${counts.present + counts.late} in school, ${absent} away` +
      `${counts.late > 0 ? ` (${counts.late} late)` : ""}.${tail}`,
    savedAt: new Date().toISOString(),
  };
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
