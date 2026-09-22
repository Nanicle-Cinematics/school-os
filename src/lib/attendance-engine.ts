import "server-only";

import type { TenantTx } from "@/lib/prisma";

/**
 * Not in `attendance-actions.ts`, and the reason is a rule rather than taste.
 *
 * Every export of a `"use server"` module is published as a server action — a
 * callable endpoint whose arguments arrive from the network. `syncAttendanceTotals`
 * takes a live transaction handle, which cannot survive that trip and has no
 * business being reachable from a browser in the first place. So the derivation
 * lives here, beside the actions that call it, exactly as `results-engine` sits
 * beside `results-actions`.
 */

/**
 * Put the term's attendance onto the report card.
 *
 * `TermResult.daysPresent/daysTotal` have been typed by hand since the card
 * existed. Now they are derived — but ONLY for a class whose register has
 * actually been taken, because a school still keeping paper must not have its
 * typed-in figures wiped by a module it has not started using.
 *
 * The denominator is per CHILD: a child who joined in October is marked out of
 * the days they were here, not out of a term that started without them. A
 * PUBLISHED card is left alone, like everywhere else.
 */
export async function syncAttendanceTotals(
  tx: TenantTx,
  schoolId: string,
  termId: string,
  classGroupId: string,
) {
  const days = await tx.attendanceDay.findMany({
    where: { termId, classGroupId },
    select: { id: true },
  });
  if (days.length === 0) {
    return { students: 0, days: 0 };
  }

  const entries = await tx.attendanceEntry.findMany({
    where: { attendanceDayId: { in: days.map((day) => day.id) } },
    select: { studentId: true, mark: true },
  });

  const totals = new Map<string, { present: number; days: number }>();
  for (const entry of entries) {
    const row = totals.get(entry.studentId) ?? { present: 0, days: 0 };
    row.days += 1;
    if (entry.mark === "PRESENT" || entry.mark === "LATE") {
      row.present += 1;
    }
    totals.set(entry.studentId, row);
  }

  let written = 0;
  for (const [studentId, row] of totals) {
    const existing = await tx.termResult.findUnique({
      where: { termId_studentId: { termId, studentId } },
      select: { status: true },
    });
    if (existing?.status === "PUBLISHED") {
      continue;
    }

    const fields = { daysPresent: row.present, daysTotal: row.days };
    // upsert, not update: the register is taken all term, long before anyone
    // computes a result for this child to attach it to.
    await tx.termResult.upsert({
      where: { termId_studentId: { termId, studentId } },
      create: { schoolId, termId, studentId, classGroupId, ...fields },
      update: fields,
    });
    written += 1;
  }

  return { students: written, days: days.length };
}
