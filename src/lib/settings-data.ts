import "server-only";

import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export async function getSettings(schoolId: string) {
  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId } });

  const gradingScales = await prisma.gradingScale.findMany({
    orderBy: { name: "asc" },
    include: {
      bands: { orderBy: { minScore: "desc" } },
      _count: { select: { subjectResults: true } },
    },
  });

  const years = await prisma.academicYear.findMany({
    orderBy: { startDate: "desc" },
    include: { terms: { orderBy: { sequence: "asc" } } },
  });

  return { school, settings, gradingScales, years };
}
