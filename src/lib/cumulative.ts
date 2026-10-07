/**
 * A JHS pupil's results across the three JHS years, as one grid.
 *
 * Pure — rows in, grid out — so `verify:results` can pin the layout rules
 * without a database, and the page and any later print run read one answer.
 *
 * The columns are the pupil's own JHS years, three terms each. Three rules
 * decide which years appear, and each is the honest reading of a gap:
 *
 * - a JHS level the pupil was enrolled at is shown, every term of it, with a
 *   term that has no results printed as a dash rather than dropped — a hole in
 *   the record must stay visible on paper;
 * - a JHS level BELOW the pupil's own with no enrolment is shown as "not
 *   recorded" — a pupil in JHS 3 with no JHS 1 either joined later or has not
 *   been entered yet, and the sheet must say which question to ask;
 * - a level ABOVE the pupil's own is left out — a JHS 2 pupil has no JHS 3 yet,
 *   and nine columns of which three can never be filled is noise.
 *
 * A pupil who repeated a level has two years at it, and both are shown: the
 * record is what happened, not what should have.
 */

export type CumulativeLevel = { id: string; name: string; order: number };

export type CumulativeInput = {
  /** The school's JHS levels, any order. */
  levels: CumulativeLevel[];
  /** The level the pupil is in now, or null for a pupil who has left. */
  currentLevelOrder: number | null;
  enrolments: {
    academicYear: { id: string; name: string; startDate: Date };
    classGroup: { name: string; level: CumulativeLevel };
  }[];
  terms: { id: string; academicYearId: string; sequence: number }[];
  termResults: {
    termId: string;
    totalMarks: number | null;
    possibleMarks: number | null;
    percentage: number | null;
    classPosition: number | null;
    classSize: number | null;
    status: string;
    source: string;
  }[];
  subjectResults: { termId: string; subjectId: string; totalScore: number | null; grade: string | null }[];
  /** The curriculum of the levels shown, plus anything with a result. */
  subjects: { id: string; name: string; order: number }[];
};

export type CumulativeTerm = {
  sequence: number;
  termId: string | null;
  /** RECORDS for a term transcribed from paper, COMPUTED for one marked here. */
  source: string | null;
  /** Not yet published or approved — the figures may still change. */
  provisional: boolean;
  totalMarks: number | null;
  possibleMarks: number | null;
  percentage: number | null;
  classPosition: number | null;
  classSize: number | null;
};

export type CumulativeYear =
  | { kind: "year"; levelName: string; yearName: string; className: string; terms: CumulativeTerm[] }
  | { kind: "missing"; levelName: string };

export type CumulativeRecord = {
  years: CumulativeYear[];
  rows: { subjectId: string; name: string; cells: ({ total: number | null; grade: string | null } | null)[] }[];
};

const SETTLED = new Set(["PUBLISHED", "APPROVED"]);

export function assembleCumulativeRecord(input: CumulativeInput): CumulativeRecord {
  const levels = [...input.levels].sort((a, b) => a.order - b.order);
  const enrolledOrders = input.enrolments.map((e) => e.classGroup.level.order);
  // How far up the ladder to show: the pupil's own level, or the highest JHS
  // level they were ever enrolled at for a pupil who has left.
  const top = Math.max(input.currentLevelOrder ?? -Infinity, ...enrolledOrders);

  const resultByTerm = new Map(input.termResults.map((r) => [r.termId, r]));
  const years: CumulativeYear[] = [];

  for (const level of levels) {
    if (level.order > top) continue;
    const atLevel = input.enrolments
      .filter((e) => e.classGroup.level.id === level.id)
      .sort((a, b) => a.academicYear.startDate.getTime() - b.academicYear.startDate.getTime());
    if (atLevel.length === 0) {
      years.push({ kind: "missing", levelName: level.name });
      continue;
    }
    for (const enrolment of atLevel) {
      const terms: CumulativeTerm[] = [1, 2, 3].map((sequence) => {
        const term = input.terms.find(
          (t) => t.academicYearId === enrolment.academicYear.id && t.sequence === sequence,
        );
        const result = term ? resultByTerm.get(term.id) : undefined;
        return {
          sequence,
          termId: term?.id ?? null,
          source: result?.source ?? null,
          provisional: result ? !SETTLED.has(result.status) : false,
          totalMarks: result?.totalMarks ?? null,
          possibleMarks: result?.possibleMarks ?? null,
          percentage: result?.percentage ?? null,
          classPosition: result?.classPosition ?? null,
          classSize: result?.classSize ?? null,
        };
      });
      years.push({
        kind: "year",
        levelName: level.name,
        yearName: enrolment.academicYear.name,
        // "Gold" and "JHS 1 Gold" are both ways a school names a class.
        className: enrolment.classGroup.name.toLowerCase().startsWith(level.name.toLowerCase())
          ? enrolment.classGroup.name
          : `${level.name} ${enrolment.classGroup.name}`,
        terms,
      });
    }
  }

  // One column per term slot, in the order the years were laid out; a missing
  // year contributes three empty columns so every row lines up with the header.
  const columns: (string | null)[] = years.flatMap((year) =>
    year.kind === "missing" ? [null, null, null] : year.terms.map((t) => t.termId),
  );

  const byKey = new Map(input.subjectResults.map((r) => [`${r.termId}:${r.subjectId}`, r]));
  const rows = [...input.subjects]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((subject) => ({
      subjectId: subject.id,
      name: subject.name,
      cells: columns.map((termId) => {
        if (!termId) return null;
        const hit = byKey.get(`${termId}:${subject.id}`);
        return hit ? { total: hit.totalScore, grade: hit.grade } : null;
      }),
    }));

  return { years, rows };
}
