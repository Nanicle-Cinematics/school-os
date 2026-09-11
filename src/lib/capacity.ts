import "server-only";

import { prisma } from "@/lib/prisma";
import { capacity, capacityMessage, PLANS } from "@/lib/subscription";

/**
 * May this school admit `adding` more pupils?
 *
 * ⚠️ Called by EVERY path that creates a pupil, and `verify:platform` greps
 * src/lib to prove it: a third admission path added later without this line
 * would ignore the cap silently, which is how a plan limit becomes decorative.
 * That is the same check `verify:activity` runs for audit phrases, for the same
 * reason — "remember to call it" is not a mechanism.
 *
 * Returns null when there is room, or the sentence to show the office when there
 * is not. Counts ACTIVE and ADMITTED pupils: a withdrawn or graduated child is
 * not occupying a place, and charging a school for their history would be
 * indefensible.
 */
export async function admissionBlocked(schoolId: string, adding: number): Promise<string | null> {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { plan: true, studentCap: true },
  });
  if (!school) {
    return null; // no school, no cap — the caller has bigger problems
  }

  const onRoll = await prisma.student.count({
    where: { schoolId, deletedAt: null, status: { in: ["ACTIVE", "ADMITTED"] } },
  });

  return capacityMessage(capacity(school, onRoll), adding, PLANS[school.plan].label);
}
