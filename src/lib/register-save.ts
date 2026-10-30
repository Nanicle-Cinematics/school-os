import "server-only";

import type { AttendanceMark } from "@prisma/client";
import type { AuthContext } from "@/lib/auth";
import { OFFICE, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { ownsClasses } from "@/lib/ownership";
import { parseDay, termForDate } from "@/lib/attendance-data";
import { syncAttendanceTotals } from "@/lib/attendance-engine";
import { writeAudit } from "@/lib/audit";

/**
 * Writing a register, in ONE place for the two ways it arrives.
 *
 * The form on /attendance posts here through the `saveRegister` action, and a
 * register taken without a signal arrives later through /api/attendance/sync.
 * They must enforce the same rules (who may mark, which term, who is on the
 * roll), so the rules live in this file and neither caller repeats them.
 * It is not a "use server" module: every export of one is a callable endpoint,
 * and these take the signed-in context as an argument.
 */

const MARKS: AttendanceMark[] = ["PRESENT", "LATE", "EXCUSED", "ABSENT"];

export type RegisterInput = {
  classGroupId: string;
  /** yyyy-mm-dd, as typed. */
  dateRaw: string;
  /** studentId -> a mark, or "" for "not marked". */
  marks: Map<string, string>;
  notes: Map<string, string>;
  /**
   * "all": the post covers the WHOLE roll, so a child with no mark has their
   * entry removed (the online form, where what is on screen is the register).
   *
   * "listed": the post covers only the children the sender knew about, and
   * touches no one else. A register taken offline was marked against a roll
   * downloaded earlier; a child who joined the class since is not on that
   * phone, and the office may already have marked them. Treating the phone's
   * silence about them as "unmarked" would delete a mark the phone never saw.
   */
  scope: "all" | "listed";
  /** Set when the register was taken without a signal: when the phone saved it. */
  offline?: { markedAt: string } | null;
};

export type RegisterResult =
  | { error: string }
  | { ok: string; marked: number; unmarked: number; skipped: number };

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
export async function mayMark(
  auth: Pick<AuthContext, "roles" | "staffId">,
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

/**
 * Mark, or re-mark, one class's register for one day.
 *
 * The caller has already run `requireRole(ATTENDANCE)` and `setTenantContext`.
 */
export async function saveRegisterFor(
  auth: Pick<AuthContext, "roles" | "staffId" | "schoolId" | "userId">,
  input: RegisterInput,
): Promise<RegisterResult> {
  const { classGroupId, dateRaw } = input;
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

  // An id from a request is read back through the tenant client before it is
  // written into a referencing column (see ownership.ts): a register for another
  // school's class would claim that class's (class, day) slot for good.
  if (!(await ownsClasses([classGroupId]))) {
    return { error: "That class was not found." };
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

  // Whose marks this post speaks for.
  const subjects =
    input.scope === "all" ? [...enrolled] : [...input.marks.keys()].filter((id) => enrolled.has(id));
  const skipped =
    input.scope === "all" ? 0 : [...input.marks.keys()].filter((id) => !enrolled.has(id)).length;

  type Entry = { studentId: string; mark: AttendanceMark; note: string | null };
  const entries: Entry[] = [];
  const cleared: string[] = [];
  let unmarked = 0;

  for (const studentId of subjects) {
    const raw = input.marks.get(studentId) ?? "";
    if (!raw) {
      // Left blank is "not marked", not "present". A register with holes in it
      // is the honest record of a register with holes in it.
      unmarked += 1;
      cleared.push(studentId);
      continue;
    }
    if (!MARKS.includes(raw as AttendanceMark)) {
      return { error: `“${raw}” is not a mark.` };
    }
    const note = (input.notes.get(studentId) ?? "").trim();
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
      // answered today. Offline, only the children the phone listed.
      await tx.attendanceEntry.deleteMany({
        where:
          input.scope === "all"
            ? { attendanceDayId: day.id, studentId: { notIn: entries.map((e) => e.studentId) } }
            : { attendanceDayId: day.id, studentId: { in: cleared } },
      });

      await syncAttendanceTotals(tx, auth.schoolId, term.id, classGroupId);

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "attendance.register",
        entity: "ClassGroup",
        entityId: classGroupId,
        after: {
          date: dateRaw,
          termId: term.id,
          marked: entries.length,
          ...counts,
          // Said in the trail, so a late arrival is not mistaken for a register
          // taken at the time it was written.
          ...(input.offline ? { offline: true, markedAt: input.offline.markedAt } : {}),
        },
      });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const away = counts.absent + counts.excused;
  const tail =
    (unmarked > 0 ? ` ${unmarked} left unmarked.` : "") +
    (skipped > 0 ? ` ${skipped} no longer in this class, left out.` : "");
  return {
    ok:
      `Register saved — ${counts.present + counts.late} in school, ${away} away` +
      `${counts.late > 0 ? ` (${counts.late} late)` : ""}.${tail}`,
    marked: entries.length,
    unmarked,
    skipped,
  };
}
