import "server-only";

import { Prisma } from "@prisma/client";
import { gradeFor, rank, type Band } from "@/lib/results-engine";

/**
 * Mock examinations, graded and aggregated the way the BECE is.
 *
 * Pure functions over plain rows, so verify:mocks can prove the arithmetic
 * without a database. Nothing here is stored: a mock's grades, aggregates and
 * positions are derived on every read from its marks and the school's grading
 * scale (see mock-data.ts). Unlike a term report card, a mock is not a document
 * a parent keeps, so there is nothing to freeze.
 */

/**
 * The four BECE core subjects. Every candidate's aggregate takes all four.
 *
 * Matched by the GES code first and the name second. `Subject.isCore` cannot be
 * used: provisioning sets it on every subject, so it marks nothing. A school
 * that renamed "Science" to "Integrated Science" still matches on its code.
 */
const CORE_CODES = new Set(["ENG", "MAT", "SCI", "SOC"]);
const CORE_NAMES = [
  /^english/i,
  /^math/i,
  /^(integrated\s+|general\s+)?science$/i,
  /^social\s+studies$/i,
];

export function isBeceCore(subject: { code: string; name: string }) {
  return CORE_CODES.has(subject.code.toUpperCase()) || CORE_NAMES.some((re) => re.test(subject.name.trim()));
}

/** How many core subjects and how many best "other" subjects make an aggregate. */
export const BECE_CORES = 4;
export const BECE_BEST_OTHERS = 2;

export type MockSubject = { id: string; code: string; name: string };
export type MockMark = { studentId: string; subjectId: string; rawScore: number | null; isAbsent: boolean };

export type SubjectCell = {
  /** The mark out of 100; 0 for an absent candidate. Null = not marked yet. */
  score: number | null;
  isAbsent: boolean;
  grade: string | null;
  points: number | null;
  /** The band's word for it — "Credit", "Pass" — printed on a slip. */
  remark: string | null;
};

export type AggregateResult = {
  aggregate: number | null;
  /** Why there is no aggregate, in words an office can act on. */
  missing: string | null;
  /** The subjects that made the aggregate, so a slip can mark them. */
  counted: string[];
};

/**
 * BECE aggregate: the grade points of all four core subjects plus the best two
 * of the rest. Lower is better; 6 is perfect, 54 the floor.
 *
 * A candidate with a core subject unmarked, or fewer than two other subjects
 * marked, has NO aggregate rather than a flattering partial one: the real exam
 * would not compute one either, and a "6" built from three subjects is the kind
 * of figure that reaches a parent and is believed. Absent is marked (a 0, so the
 * lowest grade) — that is what absence costs in the real exam.
 */
export function beceAggregate(
  subjects: (MockSubject & { core: boolean })[],
  cells: Map<string, SubjectCell>,
): AggregateResult {
  const graded = (subject: MockSubject) => {
    const cell = cells.get(subject.id);
    return cell && cell.points !== null ? cell.points : null;
  };

  const cores = subjects.filter((s) => s.core);
  if (cores.length < BECE_CORES) {
    return {
      aggregate: null,
      missing: `Only ${cores.length} of the ${BECE_CORES} core subjects are offered at this level.`,
      counted: [],
    };
  }
  const unmarkedCores = cores.filter((s) => graded(s) === null);
  if (unmarkedCores.length > 0) {
    return {
      aggregate: null,
      missing: `No mark in ${unmarkedCores.map((s) => s.name).join(", ")}.`,
      counted: [],
    };
  }

  const others = subjects
    .filter((s) => !s.core && graded(s) !== null)
    .sort((a, b) => (graded(a) as number) - (graded(b) as number));
  if (others.length < BECE_BEST_OTHERS) {
    return {
      aggregate: null,
      missing: `Needs marks in at least ${BECE_BEST_OTHERS} subjects besides the core four.`,
      counted: [],
    };
  }

  const best = others.slice(0, BECE_BEST_OTHERS);
  const used = [...cores, ...best];
  return {
    aggregate: used.reduce((sum, s) => sum + (graded(s) as number), 0),
    missing: null,
    counted: used.map((s) => s.id),
  };
}

export type BroadsheetRow = {
  studentId: string;
  cells: Map<string, SubjectCell>;
  /** Sum of the marks entered, out of 100 per subject marked. */
  total: number;
  marked: number;
} & AggregateResult & { position: number | null };

/**
 * Every candidate's marks, grades, aggregate and position for one mock.
 *
 * Positions are by aggregate alone, ties sharing a place (1, 2, 2, 4) as the
 * term results do — two candidates on the same aggregate are level, and a
 * tie-break on raw marks would invent an order the exam itself does not have.
 * A candidate without an aggregate is unplaced, not last.
 */
export function mockBroadsheet(input: {
  subjects: MockSubject[];
  studentIds: string[];
  marks: MockMark[];
  bands: Band[];
}): { rows: BroadsheetRow[]; subjects: (MockSubject & { core: boolean })[] } {
  const subjects = input.subjects.map((s) => ({ ...s, core: isBeceCore(s) }));
  const bySubject = new Set(subjects.map((s) => s.id));

  const markFor = new Map<string, MockMark>();
  for (const mark of input.marks) {
    if (bySubject.has(mark.subjectId)) markFor.set(`${mark.studentId}:${mark.subjectId}`, mark);
  }

  const rows = input.studentIds.map((studentId) => {
    const cells = new Map<string, SubjectCell>();
    let total = 0;
    let marked = 0;
    for (const subject of subjects) {
      const mark = markFor.get(`${studentId}:${subject.id}`);
      const score = mark ? (mark.isAbsent ? 0 : mark.rawScore) : null;
      const band = score === null ? null : gradeFor(input.bands, new Prisma.Decimal(score));
      cells.set(subject.id, {
        score,
        isAbsent: mark?.isAbsent ?? false,
        grade: band?.grade ?? null,
        points: band?.points ?? null,
        remark: band?.remark ?? null,
      });
      if (score !== null) {
        total += score;
        marked += 1;
      }
    }
    return { studentId, cells, total, marked, ...beceAggregate(subjects, cells), position: null as number | null };
  });

  // rank() puts the HIGHEST value first; a lower aggregate is better.
  const positions = rank(rows, (row) => (row.aggregate === null ? null : -row.aggregate));
  for (const row of rows) row.position = positions.get(row) ?? null;

  rows.sort((a, b) => {
    if (a.position !== null && b.position !== null) return a.position - b.position;
    if (a.position !== null) return -1;
    if (b.position !== null) return 1;
    return b.total - a.total;
  });

  return { rows, subjects };
}

/**
 * Whether a candidate is improving, from their aggregates in successive mocks.
 * Negative is better: an aggregate falling from 24 to 18 is six places of
 * improvement. Measured from the first mock they have an aggregate in to the
 * latest, so a mock they missed does not read as a collapse.
 */
export function aggregateChange(aggregates: (number | null)[]) {
  const known = aggregates.filter((value): value is number => value !== null);
  if (known.length < 2) return null;
  return known[known.length - 1] - known[0];
}
