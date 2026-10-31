/**
 * The rules of the timetable. Pure: no database, no React, so the server, the
 * browser and `verify:timetable` all run the SAME functions.
 *
 * The shape, because the rules only make sense inside it:
 *
 *  - The school sets its day ONCE: a list of periods (breaks included), the same
 *    every weekday.
 *  - A lesson is a class, a subject, a weekday and a period. Nothing else is
 *    stored. Who teaches it is whoever holds the TeachingAssignment for that
 *    class and subject this year, worked out when the timetable is READ
 *    (`teachersFor`), so changing an assignment changes the timetable instead of
 *    leaving a stale name on it.
 *  - Because the teacher is not stored, a clash (one teacher, two classes, one
 *    period) cannot be left to the database. It is refused when a lesson is
 *    placed (`findTeacherClash`) and shown again on every read (`clashes`), for
 *    the assignment edited AFTER the lessons were placed.
 */

export const WEEKDAYS = [
  { n: 1, label: "Monday", short: "Mon" },
  { n: 2, label: "Tuesday", short: "Tue" },
  { n: 3, label: "Wednesday", short: "Wed" },
  { n: 4, label: "Thursday", short: "Thu" },
  { n: 5, label: "Friday", short: "Fri" },
] as const;

export function weekdayLabel(n: number) {
  return WEEKDAYS.find((day) => day.n === n)?.label ?? `Day ${n}`;
}

export function isWeekday(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5;
}

export const MAX_PERIODS = 14;
const LABEL_MAX = 30;

export type PeriodInput = { label: string; startTime: string; endTime: string; isBreak: boolean };
export type PeriodRow = PeriodInput & { id: string; order: number };

/** "08:05" to minutes after midnight, or null when it is not a time of day. */
export function parseTime(value: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** "8:5" is accepted by a person and stored as "08:05", so sorting text sorts time. */
export function normaliseTime(value: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return value.trim();
  return `${match[1].padStart(2, "0")}:${match[2].padStart(2, "0")}`;
}

export function formatRange(period: Pick<PeriodInput, "startTime" | "endTime">) {
  return `${period.startTime}–${period.endTime}`;
}

export type PeriodsCheck = { ok: true; rows: PeriodInput[] } | { ok: false; errors: string[] };

/**
 * Whether a list of periods is a day.
 *
 * Every complaint is returned, not the first: the head fixing a nine-row form
 * should not have to press Save nine times to find nine mistakes.
 */
export function checkPeriods(input: PeriodInput[]): PeriodsCheck {
  const errors: string[] = [];
  const rows = input.map((row) => ({
    label: row.label.trim(),
    startTime: normaliseTime(row.startTime),
    endTime: normaliseTime(row.endTime),
    isBreak: row.isBreak,
  }));

  if (rows.length === 0) errors.push("Add at least one period.");
  if (rows.length > MAX_PERIODS) errors.push(`A school day has at most ${MAX_PERIODS} periods and breaks.`);
  if (rows.length > 0 && rows.every((row) => row.isBreak)) errors.push("A day needs at least one lesson, not only breaks.");

  let previousEnd = -1;
  rows.forEach((row, index) => {
    const name = row.label || `Row ${index + 1}`;
    if (!row.label) errors.push(`Row ${index + 1} needs a name.`);
    else if (row.label.length > LABEL_MAX) errors.push(`“${name}” is longer than ${LABEL_MAX} characters.`);

    const start = parseTime(row.startTime);
    const end = parseTime(row.endTime);
    if (start === null) errors.push(`${name}: “${row.startTime}” is not a time. Use hours and minutes, like 08:30.`);
    if (end === null) errors.push(`${name}: “${row.endTime}” is not a time. Use hours and minutes, like 09:10.`);
    if (start === null || end === null) return;

    if (end <= start) errors.push(`${name} ends at ${row.endTime}, which is not after it starts at ${row.startTime}.`);
    if (start < previousEnd) errors.push(`${name} starts at ${row.startTime}, before the row above it ends.`);
    previousEnd = Math.max(previousEnd, end);
  });

  const seen = new Set<string>();
  for (const row of rows) {
    const key = row.label.toLowerCase();
    if (row.label && seen.has(key)) errors.push(`Two rows are called “${row.label}”. Give each its own name.`);
    seen.add(key);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, rows };
}

/**
 * A starting point, the way the GES ladder and the fee items are: seven lessons
 * and two breaks. The head corrects it for the school's real day.
 */
export const STANDARD_DAY: PeriodInput[] = [
  { label: "Period 1", startTime: "08:00", endTime: "08:40", isBreak: false },
  { label: "Period 2", startTime: "08:40", endTime: "09:20", isBreak: false },
  { label: "Break", startTime: "09:20", endTime: "09:50", isBreak: true },
  { label: "Period 3", startTime: "09:50", endTime: "10:30", isBreak: false },
  { label: "Period 4", startTime: "10:30", endTime: "11:10", isBreak: false },
  { label: "Period 5", startTime: "11:10", endTime: "11:50", isBreak: false },
  { label: "Lunch", startTime: "11:50", endTime: "12:30", isBreak: true },
  { label: "Period 6", startTime: "12:30", endTime: "13:10", isBreak: false },
  { label: "Period 7", startTime: "13:10", endTime: "13:50", isBreak: false },
];

/**
 * The period straight after this one, if a double lesson can run into it.
 *
 * Only the very next row counts and it must be a lesson: a "double" that spans
 * a break is two lessons with a break between them, and the head should place
 * that as two.
 */
export function nextLessonPeriod<T extends { id: string; order: number; isBreak: boolean }>(
  periods: T[],
  periodId: string,
): T | null {
  const sorted = [...periods].sort((a, b) => a.order - b.order);
  const index = sorted.findIndex((period) => period.id === periodId);
  if (index < 0) return null;
  const next = sorted[index + 1];
  return next && !next.isBreak ? next : null;
}

/** One lesson as the timetable is read: its teachers already worked out. */
export type PlacedLesson = {
  classGroupId: string;
  classLabel: string;
  subjectId: string;
  weekday: number;
  periodId: string;
  /** Everyone assigned to teach this subject to this class this year. Empty = nobody yet. */
  staffIds: string[];
};

export type Assignment = { staffId: string; classGroupId: string; subjectId: string };

/** Who teaches a class this subject, from the year's assignments. */
export function teachersFor(assignments: Assignment[], classGroupId: string, subjectId: string): string[] {
  return assignments
    .filter((a) => a.classGroupId === classGroupId && a.subjectId === subjectId)
    .map((a) => a.staffId);
}

/**
 * The lesson in ANOTHER class that already has one of these teachers at this
 * weekday and period, or null.
 *
 * A teacher is only ever "double-booked" against a different class: replacing a
 * class's own lesson in that cell is an edit, not a clash with itself.
 */
export function findTeacherClash(
  placing: { classGroupId: string; weekday: number; periodId: string; staffIds: string[] },
  placed: PlacedLesson[],
): { lesson: PlacedLesson; staffId: string } | null {
  if (placing.staffIds.length === 0) return null;
  for (const lesson of placed) {
    if (lesson.classGroupId === placing.classGroupId) continue;
    if (lesson.weekday !== placing.weekday || lesson.periodId !== placing.periodId) continue;
    const shared = lesson.staffIds.find((id) => placing.staffIds.includes(id));
    if (shared) return { lesson, staffId: shared };
  }
  return null;
}

export type Clash = { staffId: string; weekday: number; periodId: string; classGroupIds: string[] };

/** Every teacher booked into two classes at once, as the timetable stands now. */
export function clashes(lessons: PlacedLesson[]): Clash[] {
  const cells = new Map<string, Set<string>>();
  for (const lesson of lessons) {
    for (const staffId of lesson.staffIds) {
      const key = `${staffId}|${lesson.weekday}|${lesson.periodId}`;
      const classes = cells.get(key) ?? new Set<string>();
      classes.add(lesson.classGroupId);
      cells.set(key, classes);
    }
  }
  const found: Clash[] = [];
  for (const [key, classes] of cells) {
    if (classes.size < 2) continue;
    const [staffId, weekday, periodId] = key.split("|");
    found.push({ staffId, weekday: Number(weekday), periodId, classGroupIds: [...classes].sort() });
  }
  return found.sort((a, b) => a.weekday - b.weekday || a.periodId.localeCompare(b.periodId));
}

/** Lessons per subject, for the line under a class's grid. */
export function lessonCounts(lessons: { subjectId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const lesson of lessons) counts.set(lesson.subjectId, (counts.get(lesson.subjectId) ?? 0) + 1);
  return counts;
}

/** What a body posted to place or clear one lesson must look like. */
export type SlotRequest = {
  classGroupId: string;
  weekday: number;
  periodId: string;
  /** "" clears the lesson. */
  subjectId: string;
  /** Also fill the next lesson period with the same subject. */
  double: boolean;
};

export type ParsedSlot = { ok: true; value: SlotRequest } | { ok: false; error: string };

export function parseSlotRequest(body: unknown): ParsedSlot {
  if (!body || typeof body !== "object") return { ok: false, error: "Expected a lesson." };
  const { classGroupId, weekday, periodId, subjectId, double } = body as Record<string, unknown>;
  const id = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 64;
  if (!id(classGroupId)) return { ok: false, error: "No class." };
  if (!isWeekday(weekday)) return { ok: false, error: "That is not a weekday." };
  if (!id(periodId)) return { ok: false, error: "No period." };
  if (subjectId !== "" && !id(subjectId)) return { ok: false, error: "No subject." };
  if (double !== undefined && typeof double !== "boolean") return { ok: false, error: "Double must be true or false." };
  if (double && subjectId === "") return { ok: false, error: "Choose a subject for a double lesson." };
  return {
    ok: true,
    value: {
      classGroupId: classGroupId as string,
      weekday,
      periodId: periodId as string,
      subjectId: subjectId as string,
      double: double === true,
    },
  };
}
