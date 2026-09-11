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

/**
 * The business, in the numbers an owner actually asks about.
 *
 * Cross-tenant by nature, so withBypass — and deliberately five aggregates
 * rather than a per-school fan-out, because this runs on every load of the
 * console and the pool holds one connection.
 */
export async function getPlatformTotals() {
  return withBypass(async () => {
    const schools = await prisma.school.count({ where: { deletedAt: null } });
    const pupils = await prisma.student.count({ where: { deletedAt: null, status: "ACTIVE" } });

    const byStatus = await prisma.school.groupBy({
      by: ["subscriptionStatus"],
      where: { deletedAt: null },
      _count: { _all: true },
    });

    // What the platform has spent on texts, which is the one cost that scales
    // with use and the one a school can run up without noticing.
    const sms = await prisma.message.aggregate({
      where: { status: "SENT" },
      _sum: { cost: true },
      _count: { _all: true },
    });

    // Trials ending within the week — the only thing on this screen that is
    // time-sensitive, and the reason to open it on a Monday.
    const soon = await prisma.school.findMany({
      where: {
        deletedAt: null,
        subscriptionStatus: "TRIALING",
        trialEndsAt: { not: null, lte: new Date(Date.now() + 7 * 86_400_000) },
      },
      select: { id: true, name: true, trialEndsAt: true },
      orderBy: { trialEndsAt: "asc" },
    });

    return {
      schools,
      pupils,
      byStatus: Object.fromEntries(byStatus.map((row) => [row.subscriptionStatus, row._count._all])),
      smsSent: sms._count._all,
      smsCost: Number(sms._sum.cost ?? 0),
      trialsEndingSoon: soon,
    };
  });
}

/** One school, for the console's detail screen. */
export async function getSchoolForPlatform(schoolId: string) {
  return withBypass(async () => {
    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: {
        id: true, name: true, slug: true, shortName: true, plan: true,
        subscriptionStatus: true, studentCap: true, trialEndsAt: true, createdAt: true,
        email: true, phone: true, town: true, region: true,
      },
    });
    if (!school) {
      return null;
    }

    const pupils = await prisma.student.count({
      where: { schoolId, deletedAt: null, status: "ACTIVE" },
    });
    const staff = await prisma.staff.count({ where: { schoolId, deletedAt: null } });
    const parents = await prisma.membership.count({ where: { schoolId, role: "PARENT" } });
    const owners = await prisma.membership.findMany({
      where: { schoolId, role: "OWNER" },
      select: { user: { select: { name: true, email: true, phone: true } } },
    });
    const sms = await prisma.message.aggregate({
      where: { schoolId, status: "SENT" },
      _sum: { cost: true },
      _count: { _all: true },
    });
    const invoiced = await prisma.invoice.aggregate({
      where: { schoolId, status: { not: "CANCELLED" } },
      _sum: { total: true, amountPaid: true },
    });
    const lastSeen = await prisma.session.findFirst({
      where: { user: { memberships: { some: { schoolId } } } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });

    return {
      ...school,
      pupils,
      staff,
      parents,
      owners: owners.map((o) => o.user),
      smsSent: sms._count._all,
      smsCost: Number(sms._sum.cost ?? 0),
      billed: Number(invoiced._sum.total ?? 0),
      collected: Number(invoiced._sum.amountPaid ?? 0),
      lastSignIn: lastSeen?.createdAt ?? null,
    };
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
