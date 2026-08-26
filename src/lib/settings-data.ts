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

/**
 * How many records hang off each academic year.
 *
 * A year that has been billed, graded or enrolled against must not be deleted:
 * Invoice, TermResult, Assessment and FeeStructure all cascade from Term, which
 * cascades from AcademicYear, so removing it would take a school's billing and
 * grade history with it. Shared by both screens that offer the delete, so the
 * two cannot drift into disagreeing about what is safe.
 */
export async function getYearUsage(
  years: { id: string; terms: { id: string }[] }[],
): Promise<Map<string, number>> {
  const usage = new Map<string, number>();
  for (const year of years) {
    const termIds = year.terms.map((term) => term.id);
    const invoices = await prisma.invoice.count({ where: { termId: { in: termIds } } });
    const results = await prisma.termResult.count({ where: { termId: { in: termIds } } });
    const enrolments = await prisma.enrollment.count({ where: { academicYearId: year.id } });
    usage.set(year.id, invoices + results + enrolments);
  }
  return usage;
}
