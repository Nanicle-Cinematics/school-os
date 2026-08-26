import "server-only";

import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

/**
 * Every school on the platform.
 *
 * Wrapped in withBypass because this is the one screen that is legitimately
 * cross-tenant: with RLS on, a tenant-scoped read would return whichever school
 * the reader happened to belong to, which for a console listing all of them is
 * worse than useless.
 */
export async function getPlatformOverview() {
  return withBypass(async () => {
    const schools = await prisma.school.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        name: true,
        slug: true,
        shortName: true,
        plan: true,
        subscriptionStatus: true,
        studentCap: true,
        createdAt: true,
        _count: { select: { students: true, staff: true, memberships: true } },
      },
    });

    const activeStudents = await prisma.student.groupBy({
      by: ["schoolId"],
      where: { deletedAt: null, status: "ACTIVE" },
      _count: { _all: true },
    });
    const onRoll = new Map(activeStudents.map((row) => [row.schoolId, row._count._all]));

    const owners = await prisma.membership.findMany({
      where: { role: "OWNER" },
      select: { schoolId: true, user: { select: { name: true, email: true } } },
    });
    const ownerBySchool = new Map<string, { name: string; email: string | null }>();
    for (const owner of owners) {
      if (!ownerBySchool.has(owner.schoolId)) {
        ownerBySchool.set(owner.schoolId, owner.user);
      }
    }

    return schools.map((school) => ({
      ...school,
      onRoll: onRoll.get(school.id) ?? 0,
      owner: ownerBySchool.get(school.id) ?? null,
    }));
  });
}

/** Turn a school's name into a URL key: "St. Mary's Prep" → "st-marys-prep". */
export function slugify(input: string) {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}
