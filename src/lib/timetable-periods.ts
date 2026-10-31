import "server-only";

import type { AuthContext } from "@/lib/auth";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { STANDARD_DAY, checkPeriods } from "@/lib/timetable-rules";

/**
 * The school day: set once, the same every weekday.
 *
 * Not a "use server" module (every export of one is a callable endpoint); the
 * caller is the JSON route, which has already run `requireRole` and
 * `setTenantContext`.
 */

export type PeriodsResult = { error: string } | { errors: string[] } | { ok: string };

export type PeriodsPost = { id?: string; label: string; startTime: string; endTime: string; isBreak: boolean };

/** The standard day's rows, for provisioning to `createMany` inside its own transaction. */
export function standardDayRows(schoolId: string) {
  return STANDARD_DAY.map((row, index) => ({ schoolId, order: index + 1, ...row }));
}

/**
 * Replace the day with the list posted.
 *
 * A row that carries an id keeps its lessons (it is edited in place); a row
 * without one is new; an existing period missing from the list is removed. A
 * period that has lessons on it can be neither removed nor turned into a break,
 * and the refusal says how many lessons are in the way: the foreign key would
 * restrict the delete anyway, but "constraint failed" is no way to tell a head.
 */
export async function replacePeriods(
  auth: Pick<AuthContext, "schoolId" | "userId">,
  rows: PeriodsPost[],
): Promise<PeriodsResult> {
  const checked = checkPeriods(rows);
  if (!checked.ok) {
    return { errors: checked.errors };
  }

  const existing = await prisma.timetablePeriod.findMany({ select: { id: true, label: true, isBreak: true } });
  const known = new Map(existing.map((p) => [p.id, p]));

  // An id from a request must be one of this school's own (read back through the tenant client).
  const ids = rows.map((row) => row.id).filter((id): id is string => Boolean(id));
  if (ids.some((id) => !known.has(id))) {
    return { error: "A period in the list was not found. Reload the page and try again." };
  }
  if (new Set(ids).size !== ids.length) {
    return { error: "The same period appears twice. Reload the page and try again." };
  }

  const uses = await prisma.timetableSlot.groupBy({ by: ["periodId"], _count: { _all: true } });
  const inUse = new Map(uses.map((u) => [u.periodId, u._count._all]));
  const lessons = (n: number) => `${n} lesson${n === 1 ? "" : "s"}`;

  const blockers: string[] = [];
  const kept = new Set(ids);
  for (const period of existing) {
    const n = inUse.get(period.id) ?? 0;
    if (n > 0 && !kept.has(period.id)) {
      blockers.push(`${period.label} has ${lessons(n)} on the timetable, so it cannot be removed. Clear them first.`);
    }
  }
  rows.forEach((row, index) => {
    if (!row.id || !row.isBreak) return;
    const n = inUse.get(row.id) ?? 0;
    if (n > 0) blockers.push(`${checked.rows[index].label} has ${lessons(n)} on the timetable, so it cannot become a break. Clear them first.`);
  });
  if (blockers.length > 0) {
    return { errors: blockers };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    // (schoolId, order) is unique and not deferrable, so moving rows past each
    // other would collide mid-way. Park everything out of range first.
    const OFFSET = 1000;
    for (const period of existing) {
      await tx.timetablePeriod.update({ where: { id: period.id }, data: { order: { increment: OFFSET } } });
    }
    for (const id of existing.map((p) => p.id).filter((id) => !kept.has(id))) {
      await tx.timetablePeriod.delete({ where: { id } });
    }
    for (const [index, row] of checked.rows.entries()) {
      const id = rows[index].id;
      if (id) {
        await tx.timetablePeriod.update({ where: { id }, data: { ...row, order: index + 1 } });
      } else {
        await tx.timetablePeriod.create({ data: { ...row, order: index + 1, schoolId: auth.schoolId } });
      }
    }
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "timetable.periods",
      entity: "School",
      entityId: auth.schoolId,
      after: { periods: checked.rows.length, lessonPeriods: checked.rows.filter((r) => !r.isBreak).length },
    });
  });

  return { ok: `Saved: ${checked.rows.filter((r) => !r.isBreak).length} lesson periods in the day.` };
}

/** Give a school with no day the standard one. Does nothing to a school that has one. */
export async function applyStandardDay(auth: Pick<AuthContext, "schoolId" | "userId">): Promise<PeriodsResult> {
  const any = await prisma.timetablePeriod.count();
  if (any > 0) {
    return { error: "This school already has a school day. Edit it instead." };
  }
  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.timetablePeriod.createMany({ data: standardDayRows(auth.schoolId), skipDuplicates: true });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "timetable.periods",
      entity: "School",
      entityId: auth.schoolId,
      after: { standard: true, periods: STANDARD_DAY.length },
    });
  });
  return { ok: "The standard school day was added. Change the times to match yours." };
}
