import "server-only";

import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export async function getGradingScales(schoolId: string) {
  const scales = await prisma.gradingScale.findMany({
    orderBy: { name: "asc" },
    include: {
      bands: { orderBy: { minScore: "desc" } },
      _count: { select: { subjectResults: true } },
    },
  });

  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId },
    select: { defaultGradingScaleId: true },
  });

  return {
    scales,
    defaultScaleId: settings?.defaultGradingScaleId ?? null,
  };
}

/**
 * A scale is frozen once any result has been graded against it.
 *
 * `SubjectResult` stores the grade it was given, but the band rows are what a
 * reprint reads to explain that grade — moving a boundary afterwards rewrites
 * history on a report card a parent already has on paper.
 */
export function isFrozen(scale: { _count: { subjectResults: number } }) {
  return scale._count.subjectResults > 0;
}
