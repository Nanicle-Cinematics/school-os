import { rank } from "@/lib/results-engine";
import { sbaFigure } from "@/lib/sba";

/**
 * A JHS class's results across JHS 1 to JHS 3, one row per pupil.
 *
 * Pure — rows in, grid out — so verify:results can pin the arithmetic without
 * a database, and the screen and the printout cannot disagree.
 *
 * Two figures, both chosen to be read without an explanation and neither
 * claiming to be the GES/WAEC school-based assessment, whose rule is not
 * settled yet:
 *
 * - per subject, the pupil's AVERAGE term mark across the JHS terms on record,
 *   printed with HOW MANY terms it averages. A term with no mark is left out of
 *   the average — dividing by nine when three were never recorded would print
 *   the school's missing paperwork as the child's weakness — but the count
 *   sits beside the figure, so the hole is still on the page;
 * - overall, the marks over the marks available across every term on record.
 *   The same rule `applyYearPromotion` uses for a year, stretched to three, so
 *   a pupil who missed a subject in a term is marked down for it exactly as
 *   their report card marked them down.
 *
 * Positions follow the overall percentage, ties shared, as everywhere else.
 */

export type BroadsheetInput = {
  pupils: { id: string; firstName: string; lastName: string; admissionNo: string }[];
  subjects: { id: string; name: string; order: number }[];
  /** JHS terms only — the loader decides which years count. */
  termResults: { studentId: string; termId: string; totalMarks: number | null; possibleMarks: number | null; source: string }[];
  subjectResults: {
    studentId: string;
    termId: string;
    subjectId: string;
    totalScore: number | null;
    /** Scaled to `classWeight`; null for a term entered as a total only. */
    classScore?: number | null;
  }[];
  /** termId → academicYearId, so the SBA figure can weight each JHS year equally. */
  yearOfTerm?: Record<string, string>;
  /** What a class score is out of (SchoolSettings.classScoreWeight). */
  classWeight?: number;
};

export type BroadsheetRow = {
  pupil: BroadsheetInput["pupils"][number];
  cells: { average: number | null; terms: number; sba: number | null; sbaYears: number }[];
  termsOnRecord: number;
  fromRecords: boolean;
  marks: number | null;
  possible: number | null;
  percentage: number | null;
  position: number | null;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

export function assembleJhsBroadsheet(input: BroadsheetInput): {
  subjects: BroadsheetInput["subjects"];
  rows: BroadsheetRow[];
} {
  const subjects = [...input.subjects].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  const rows: BroadsheetRow[] = input.pupils.map((pupil) => {
    const own = input.subjectResults.filter((r) => r.studentId === pupil.id);
    const lines = own.filter((r) => r.totalScore !== null);
    const cells = subjects.map((subject) => {
      const marks = lines.filter((r) => r.subjectId === subject.id).map((r) => r.totalScore as number);
      const sba = sbaFigure(
        own
          .filter((r) => r.subjectId === subject.id)
          .map((r) => ({ yearId: input.yearOfTerm?.[r.termId] ?? r.termId, classScore: r.classScore ?? null })),
        input.classWeight ?? 30,
      );
      return {
        average: marks.length ? round1(marks.reduce((a, b) => a + b, 0) / marks.length) : null,
        terms: marks.length,
        sba: sba.sba,
        sbaYears: sba.years,
      };
    });

    const terms = input.termResults.filter(
      (r) => r.studentId === pupil.id && r.totalMarks !== null && r.possibleMarks,
    );
    const marks = terms.reduce((sum, r) => sum + (r.totalMarks as number), 0);
    const possible = terms.reduce((sum, r) => sum + (r.possibleMarks as number), 0);

    return {
      pupil,
      cells,
      termsOnRecord: terms.length,
      fromRecords: terms.some((r) => r.source === "RECORDS"),
      marks: terms.length ? Math.round(marks * 100) / 100 : null,
      possible: terms.length ? possible : null,
      percentage: terms.length && possible ? round1((marks / possible) * 100) : null,
      position: null,
    };
  });

  const positions = rank(rows, (row) => row.percentage);
  for (const row of rows) {
    row.position = positions.get(row) ?? null;
  }

  // Best first, then the pupils with nothing on record, alphabetically — the
  // order a head reads a broadsheet in.
  rows.sort(
    (a, b) =>
      (a.position ?? Infinity) - (b.position ?? Infinity) ||
      a.pupil.lastName.localeCompare(b.pupil.lastName) ||
      a.pupil.firstName.localeCompare(b.pupil.firstName),
  );

  return { subjects, rows };
}
