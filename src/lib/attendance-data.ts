import "server-only";

import type { AttendanceMark, Gender } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Queries are sequential, not Promise.all — see class-data.ts: the pool holds
// one connection, so a fan-out only queues and then times out.

/** Marks that mean the child was in school. Late is one of them, on purpose. */
export const PRESENT_MARKS: AttendanceMark[] = ["PRESENT", "LATE"];

export const MARK_LABELS: Record<AttendanceMark, string> = {
  PRESENT: "Present",
  LATE: "Late",
  EXCUSED: "Excused",
  ABSENT: "Absent",
};

/**
 * A register belongs to a DAY, and the day is the school's, not the server's.
 *
 * `new Date("2026-09-22")` is midnight UTC, which in a timezone behind UTC is
 * the 21st — the register would file itself under yesterday for half the world.
 * Ghana is UTC+0 so it happens to be safe today, but the school is the only one
 * of those two facts we control. Everything here goes through a plain
 * yyyy-mm-dd string and a UTC-midnight Date built from its parts.
 */
export function parseDay(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return date;
}

export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function today(): string {
  return dayKey(new Date());
}

/** Which term a date falls inside. A register outside every term is refused. */
export async function termForDate(date: Date) {
  return prisma.term.findFirst({
    where: { startDate: { lte: date }, endDate: { gte: date } },
    select: {
      id: true,
      name: true,
      sequence: true,
      academicYearId: true,
      academicYear: { select: { name: true } },
    },
  });
}

/** The classes a register may be taken for, narrowed for a teacher. */
export async function getRegisterSetup(options: { staffId: string | null; teacherOnly: boolean }) {
  const year = await prisma.academicYear.findFirst({
    where: { isCurrent: true },
    select: { id: true, name: true },
  });

  let allowedIds: string[] | null = null;
  if (options.teacherOnly) {
    if (!options.staffId) {
      allowedIds = [];
    } else {
      const formOf = await prisma.classGroup.findMany({
        where: { formTeacherId: options.staffId },
        select: { id: true },
      });
      const teaching = year
        ? await prisma.teachingAssignment.findMany({
            where: { staffId: options.staffId, academicYearId: year.id },
            select: { classGroupId: true },
            distinct: ["classGroupId"],
          })
        : [];
      allowedIds = [...new Set([...formOf.map((c) => c.id), ...teaching.map((t) => t.classGroupId)])];
    }
  }

  const classGroups = await prisma.classGroup.findMany({
    where: allowedIds ? { id: { in: allowedIds } } : {},
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, level: { select: { name: true, order: true } } },
  });

  return { year, classGroups, allowedIds };
}

export type RegisterRow = {
  studentId: string;
  admissionNo: string;
  firstName: string;
  lastName: string;
  gender: Gender;
  mark: AttendanceMark | null;
  note: string | null;
};

/**
 * One class's register for one day: the roll, plus whatever is already marked.
 *
 * Boys and girls are returned separately because that is how the paper register
 * is ruled and how /classes already shows the roll — a teacher reading down a
 * familiar list makes fewer mistakes than one reading an unfamiliar one.
 */
export async function getRegister(classGroupId: string, date: Date, academicYearId: string) {
  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: {
      id: true,
      name: true,
      level: { select: { name: true } },
      formTeacher: { select: { firstName: true, lastName: true } },
    },
  });
  if (!classGroup) {
    return null;
  }

  const roster = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId, status: "ACTIVE" },
    select: {
      student: {
        select: { id: true, admissionNo: true, firstName: true, lastName: true, gender: true },
      },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });

  const day = await prisma.attendanceDay.findUnique({
    where: { classGroupId_date: { classGroupId, date } },
    select: {
      id: true,
      updatedAt: true,
      takenBy: { select: { firstName: true, lastName: true } },
      entries: { select: { studentId: true, mark: true, note: true } },
    },
  });

  const marks = new Map(day?.entries.map((entry) => [entry.studentId, entry]) ?? []);

  const rows: RegisterRow[] = roster.map(({ student }) => ({
    studentId: student.id,
    admissionNo: student.admissionNo,
    firstName: student.firstName,
    lastName: student.lastName,
    gender: student.gender,
    mark: marks.get(student.id)?.mark ?? null,
    note: marks.get(student.id)?.note ?? null,
  }));

  return {
    classGroup,
    rows,
    // Gender is required on Student, so these two cover the roll with nothing
    // left over — no third bucket to keep in step.
    boys: rows.filter((row) => row.gender === "MALE"),
    girls: rows.filter((row) => row.gender === "FEMALE"),
    taken: Boolean(day),
    takenBy: day?.takenBy ?? null,
    takenAt: day?.updatedAt ?? null,
  };
}

export type AttendanceSummaryRow = {
  studentId: string;
  name: string;
  admissionNo: string;
  present: number;
  late: number;
  excused: number;
  absent: number;
  days: number;
  percent: number | null;
};

/**
 * The term's totals for a class — what lands on the report card.
 *
 * The denominator is per CHILD, not per class: a child who joined in October is
 * marked out of the days they were actually here, not out of a term that
 * started without them.
 */
export async function getAttendanceSummary(termId: string, classGroupId: string) {
  const days = await prisma.attendanceDay.findMany({
    where: { termId, classGroupId },
    select: { id: true, date: true },
    orderBy: { date: "asc" },
  });

  if (days.length === 0) {
    return { days: [], rows: [] as AttendanceSummaryRow[] };
  }

  const entries = await prisma.attendanceEntry.findMany({
    where: { attendanceDayId: { in: days.map((day) => day.id) } },
    select: {
      studentId: true,
      mark: true,
      student: { select: { firstName: true, lastName: true, admissionNo: true } },
    },
  });

  const byStudent = new Map<string, AttendanceSummaryRow>();
  for (const entry of entries) {
    const row =
      byStudent.get(entry.studentId) ??
      ({
        studentId: entry.studentId,
        name: `${entry.student.lastName}, ${entry.student.firstName}`,
        admissionNo: entry.student.admissionNo,
        present: 0,
        late: 0,
        excused: 0,
        absent: 0,
        days: 0,
        percent: null,
      } satisfies AttendanceSummaryRow);

    row.days += 1;
    if (entry.mark === "PRESENT") row.present += 1;
    else if (entry.mark === "LATE") row.late += 1;
    else if (entry.mark === "EXCUSED") row.excused += 1;
    else row.absent += 1;

    byStudent.set(entry.studentId, row);
  }

  const rows = [...byStudent.values()]
    .map((row) => ({
      ...row,
      percent: row.days > 0 ? ((row.present + row.late) / row.days) * 100 : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { days, rows };
}
