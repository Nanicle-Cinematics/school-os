import type { Prisma } from "@prisma/client";

/**
 * Who sat in a class in a given academic year — the ONE rule for a term's roll.
 *
 * ⚠️ A class is a stream that outlives its pupils: "JHS 1 Gold" holds a new
 * cohort every September. So "who is in this class" means nothing until a year
 * is named, and three call sites each answered it differently:
 *
 * - the mark sheet and the remarks screen read `Student.currentClassGroupId`,
 *   i.e. the class TODAY, so a 2024/25 sheet listed this year's JHS 1 pupils
 *   instead of the children who sat in the room that year;
 * - `computeClassResults` read every ACTIVE enrolment in the class with no year
 *   at all, so recomputing last year's third term after the promotion had run
 *   (which flips last year's rows to COMPLETED) rolled up the NEW cohort into
 *   the old term and left the real one's totals stale;
 * - `saveSheet` and `saveClassRemarks` scoped by year but only to ACTIVE, so a
 *   finished year's roll was empty and every save was silently dropped.
 *
 * The answer is the term's year's enrolments in that class, in ANY state but
 * WITHDRAWN: COMPLETED and REPEATED are exactly what a finished year's rows are
 * called once the promotion has run, and they are still the people who sat the
 * term. A graduate is on their final year's roll even though `Student.status`
 * now says GRADUATED. A deleted pupil is not.
 *
 * Pure — a where clause, not a query — so the engine can run it inside its
 * transaction and the pages outside one, and both read the same rule.
 */
export function rosterWhere(academicYearId: string, classGroupId: string): Prisma.EnrollmentWhereInput {
  return {
    academicYearId,
    classGroupId,
    status: { not: "WITHDRAWN" },
    student: { deletedAt: null },
  };
}
