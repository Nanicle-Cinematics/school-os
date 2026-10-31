import "server-only";

import { prisma } from "@/lib/prisma";
import {
  clashes,
  lessonCounts,
  teachersFor,
  type Assignment,
  type PeriodRow,
  type PlacedLesson,
} from "@/lib/timetable-rules";

// Queries are sequential, not Promise.all — see class-data.ts: the pool holds
// four connections and a fan-out only queues and then times out.

export async function getPeriods(): Promise<PeriodRow[]> {
  return prisma.timetablePeriod.findMany({
    orderBy: { order: "asc" },
    select: { id: true, order: true, label: true, startTime: true, endTime: true, isBreak: true },
  });
}

/** How many lessons hang on each period, for "this period is in use" on the setup page. */
export async function getPeriodUse(): Promise<Map<string, number>> {
  const rows = await prisma.timetableSlot.groupBy({ by: ["periodId"], _count: { _all: true } });
  return new Map(rows.map((row) => [row.periodId, row._count._all]));
}

type Names = Map<string, string>;

const label = (c: { name: string; level: { name: string } }) => `${c.level.name} ${c.name}`;

/** Everything a view needs about the year: the lessons placed, who teaches them, who is double-booked. */
async function loadYear() {
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  if (!year) return null;

  const slots = await prisma.timetableSlot.findMany({
    where: { academicYearId: year.id },
    select: {
      classGroupId: true,
      subjectId: true,
      weekday: true,
      periodId: true,
      classGroup: { select: { name: true, level: { select: { name: true } } } },
      subject: { select: { name: true } },
    },
  });
  const assignments: Assignment[] = await prisma.teachingAssignment.findMany({
    where: { academicYearId: year.id },
    select: { staffId: true, classGroupId: true, subjectId: true },
  });
  const staff = await prisma.staff.findMany({
    where: { id: { in: [...new Set(assignments.map((a) => a.staffId))] } },
    select: { id: true, firstName: true, lastName: true },
  });
  const staffNames: Names = new Map(staff.map((s) => [s.id, `${s.firstName} ${s.lastName}`]));

  const lessons = slots.map((slot) => ({
    ...({
      classGroupId: slot.classGroupId,
      classLabel: label(slot.classGroup),
      subjectId: slot.subjectId,
      weekday: slot.weekday,
      periodId: slot.periodId,
      staffIds: teachersFor(assignments, slot.classGroupId, slot.subjectId),
    } satisfies PlacedLesson),
    subjectName: slot.subject.name,
  }));

  return { year, lessons, assignments, staffNames, clashes: clashes(lessons) };
}

export type ClassCell = {
  weekday: number;
  periodId: string;
  subjectId: string;
  subjectName: string;
  teachers: string[];
  /** One of this lesson's teachers is also in another class at this time. */
  clash: string | null;
};

/** One class's week, with the subjects it may be given. */
export async function getClassTimetable(classGroupId: string) {
  const data = await loadYear();
  if (!data) return { year: null, cells: [] as ClassCell[], subjects: [], counts: new Map<string, number>(), clashCount: 0 };

  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: { levelId: true },
  });
  const subjects = classGroup
    ? await prisma.levelSubject.findMany({
        where: { levelId: classGroup.levelId },
        orderBy: [{ order: "asc" }, { subject: { name: "asc" } }],
        select: { subject: { select: { id: true, name: true } } },
      })
    : [];

  const mine = data.lessons.filter((lesson) => lesson.classGroupId === classGroupId);
  const clashAt = new Map<string, string>();
  for (const clash of data.clashes) {
    if (!clash.classGroupIds.includes(classGroupId)) continue;
    const others = data.lessons
      .filter((l) => l.weekday === clash.weekday && l.periodId === clash.periodId && clash.classGroupIds.includes(l.classGroupId) && l.classGroupId !== classGroupId)
      .map((l) => l.classLabel);
    clashAt.set(
      `${clash.weekday}|${clash.periodId}`,
      `${data.staffNames.get(clash.staffId) ?? "A teacher"} is also in ${others.join(" and ")} at this time`,
    );
  }

  const cells: ClassCell[] = mine.map((lesson) => ({
    weekday: lesson.weekday,
    periodId: lesson.periodId,
    subjectId: lesson.subjectId,
    subjectName: lesson.subjectName,
    teachers: lesson.staffIds.map((id) => data.staffNames.get(id) ?? "A teacher"),
    clash: clashAt.get(`${lesson.weekday}|${lesson.periodId}`) ?? null,
  }));

  return {
    year: data.year,
    cells,
    subjects: subjects.map((row) => row.subject),
    counts: lessonCounts(mine),
    clashCount: new Set(cells.filter((c) => c.clash).map((c) => `${c.weekday}|${c.periodId}`)).size,
  };
}

export type TeacherCell = { weekday: number; periodId: string; lessons: { classLabel: string; subjectName: string }[] };

/**
 * One teacher's week: the lessons of every class-and-subject they are assigned
 * this year. Handed a staff id the CALLER resolved (the session's own, or the
 * office's choice from a list it was shown), never one read off a request by
 * this function.
 */
export async function getTeacherWeek(staffId: string) {
  const data = await loadYear();
  if (!data) return { year: null, cells: [] as TeacherCell[], classes: 0 };

  const mine = data.assignments.filter((a) => a.staffId === staffId);
  const key = (classGroupId: string, subjectId: string) => `${classGroupId}|${subjectId}`;
  const wanted = new Set(mine.map((a) => key(a.classGroupId, a.subjectId)));

  const byCell = new Map<string, TeacherCell>();
  for (const lesson of data.lessons) {
    if (!wanted.has(key(lesson.classGroupId, lesson.subjectId))) continue;
    const id = `${lesson.weekday}|${lesson.periodId}`;
    const cell = byCell.get(id) ?? { weekday: lesson.weekday, periodId: lesson.periodId, lessons: [] };
    cell.lessons.push({ classLabel: lesson.classLabel, subjectName: lesson.subjectName });
    byCell.set(id, cell);
  }
  return {
    year: data.year,
    cells: [...byCell.values()],
    classes: new Set(mine.map((a) => a.classGroupId)).size,
  };
}

/** Teachers who have anything assigned this year, for the office's picker. */
export async function getTeacherOptions() {
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } });
  if (!year) return [];
  const assigned = await prisma.teachingAssignment.findMany({
    where: { academicYearId: year.id },
    select: { staffId: true },
    distinct: ["staffId"],
  });
  const staff = await prisma.staff.findMany({
    where: { id: { in: assigned.map((a) => a.staffId) }, deletedAt: null },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: { id: true, firstName: true, lastName: true },
  });
  return staff.map((s) => ({ id: s.id, name: `${s.lastName}, ${s.firstName}` }));
}

/** Whether a staff id is one the office may be shown a week for (this school's, and teaching). */
export async function isListedTeacher(staffId: string) {
  return (await getTeacherOptions()).some((t) => t.id === staffId);
}

/** Every double-booking in the school, for the head's warning. */
export async function getSchoolClashes() {
  const data = await loadYear();
  if (!data) return [];
  const periods = await getPeriods();
  const periodName = new Map(periods.map((p) => [p.id, p.label]));
  return data.clashes.map((clash) => ({
    teacher: data.staffNames.get(clash.staffId) ?? "A teacher",
    weekday: clash.weekday,
    period: periodName.get(clash.periodId) ?? "a period",
    classes: data.lessons
      .filter((l) => l.weekday === clash.weekday && l.periodId === clash.periodId && clash.classGroupIds.includes(l.classGroupId))
      .map((l) => `${l.classLabel} (${l.subjectName})`),
  }));
}

export async function getClassOptions() {
  const classes = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, level: { select: { name: true } } },
  });
  return classes.map((c) => ({ id: c.id, label: label(c) }));
}
