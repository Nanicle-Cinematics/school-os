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

/**
 * Pupils who are on the roll but sit in NO class this academic year.
 *
 * "On the roll" is `Student.status` ACTIVE and not deleted; "in a class" is an enrolment for the year that is not
 * WITHDRAWN, which is the same test `rosterWhere` uses for a class. A pupil with none appears on no register,
 * no mark sheet and no class invoice run, and nothing else says so: the Students page lists them like anyone
 * (it counts the live roll, 290 in one school, against 279 enrolled). The dashboard's attention card and the
 * Students page's "no class" filter both read this, so the number on one is the list behind the other.
 *
 * The dashboard card counts the same rule with `countUnplaced` (placement.ts), which is linear in the roll where this
 * anti-join is quadratic; this stays for the Students filter, which needs a WHERE. `verify:unplaced` keeps them equal.
 */
export function unplacedWhere(academicYearId: string): Prisma.StudentWhereInput {
  return {
    deletedAt: null,
    status: "ACTIVE",
    enrollments: { none: { academicYearId, status: { not: "WITHDRAWN" } } },
  };
}
