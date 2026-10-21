import "server-only";

import { prisma, type TenantTx } from "@/lib/prisma";

/**
 * How many pupils are on the roll but sit in no class this academic year.
 *
 * Same rule as `unplacedWhere` in class-roster.ts (ACTIVE, not deleted, and no enrolment for the year that is
 * not WITHDRAWN), answered with two small reads and a set difference instead of one anti-join. As an anti-join
 * Postgres compared every pupil with every enrolment: 210,925 comparisons for one school of 650, about 55 ms
 * on every dashboard load, and growing with the SQUARE of the school's roll. This is linear in it: about 1 ms.
 * Row security made it worse, because the policy's `OR` leaves the planner without a row estimate for the inner
 * side, so it picked a nested loop and no amount of `ANALYZE` changed the choice.
 *
 * The Students page's "no class" filter still uses `unplacedWhere`, because it needs a WHERE it can page
 * through. `verify:unplaced` plants a pupil of each kind and fails if the two ever disagree.
 *
 * `db` is for scripts that must see a transaction's uncommitted rows; the app never passes it.
 */
export async function countUnplaced(schoolId: string, academicYearId: string, db?: TenantTx): Promise<number> {
  const client = (db ?? prisma) as unknown as typeof prisma;
  const live = await client.student.findMany({ where: { schoolId, deletedAt: null, status: "ACTIVE" }, select: { id: true } });
  if (live.length === 0) return 0;
  const placed = await client.enrollment.findMany({
    where: { schoolId, academicYearId, status: { not: "WITHDRAWN" } },
    select: { studentId: true },
  });
  const inAClass = new Set(placed.map((row) => row.studentId));
  return live.filter((student) => !inAClass.has(student.id)).length;
}
