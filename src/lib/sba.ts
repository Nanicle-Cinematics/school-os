/**
 * The school-based assessment (SBA) figure for one subject, out of 30.
 *
 * The rule, chosen by the school (2026-10-08) because the GES/WAEC guidance it
 * could find gives the 30/70 split but not how the 30 is built from JHS 1–3:
 *
 * 1. CLASS SCORES ONLY — the continuous-assessment part of each term, never the
 *    end-of-term exam. Each term's class score is turned into a percentage of
 *    the class-score weight it was marked out of (30 at a 30/70 school, 50 at a
 *    50/50 one), so schools and years on different splits compare.
 * 2. EACH JHS YEAR WEIGHTED EQUALLY — the terms within a year are averaged
 *    first, then the years are averaged, so a year with only one term on record
 *    still counts a third rather than a ninth.
 * 3. SCALED TO 30 — the WAEC continuous-assessment weighting.
 *
 * A term with no class score is left out, not counted as zero: that is a term
 * entered from paper records as a total only, and inventing a nought for the
 * school's missing paperwork would mark the child down for it. `years` says how
 * many years the figure stands on, so a figure resting on one year is never
 * read as one resting on three.
 *
 * Pure, and the one place this rule lives: the cumulative record and the
 * broadsheet both call it, so they cannot disagree.
 */
export type SbaEntry = {
  /** The academic year the term belongs to. */
  yearId: string;
  /** Already scaled to `classWeight`, as SubjectResult stores it. */
  classScore: number | null;
};

export const SBA_OUT_OF = 30;

export function sbaFigure(entries: SbaEntry[], classWeight: number): { sba: number | null; years: number } {
  if (!(classWeight > 0)) {
    return { sba: null, years: 0 };
  }
  const byYear = new Map<string, number[]>();
  for (const entry of entries) {
    if (entry.classScore === null || entry.classScore === undefined) continue;
    const percent = (entry.classScore / classWeight) * 100;
    byYear.set(entry.yearId, [...(byYear.get(entry.yearId) ?? []), percent]);
  }
  if (byYear.size === 0) {
    return { sba: null, years: 0 };
  }
  const yearMeans = [...byYear.values()].map((p) => p.reduce((a, b) => a + b, 0) / p.length);
  const overall = yearMeans.reduce((a, b) => a + b, 0) / yearMeans.length;
  // A hair added before rounding: 20.35 is stored as 20.3499…, and a figure a
  // head can check by hand on paper must round the way paper does (half up).
  const value = (overall * SBA_OUT_OF) / 100;
  return { sba: Math.round(value * 10 + 1e-9) / 10, years: byYear.size };
}
