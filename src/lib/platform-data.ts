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
        paidUntil: true,
        monthlyFee: true,
        trialEndsAt: true,
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

    /**
     * The money, monthly.
     *
     * MRR counts only schools that are actually paying — a suspended school's
     * fee is not revenue, and counting it would make the one number an owner
     * checks the most flattering and the least true.
     */
    const paying = await prisma.school.findMany({
      where: { deletedAt: null, subscriptionStatus: "ACTIVE" },
      select: { monthlyFee: true, paidUntil: true },
    });
    const mrr = paying.reduce((sum, s) => sum + Number(s.monthlyFee ?? 0), 0);
    const unpriced = paying.filter((s) => s.monthlyFee === null).length;

    // Due inside the week, and already overdue — the two lists that turn this
    // screen into a morning's work rather than a dashboard.
    const weekOut = new Date(Date.now() + 7 * 86_400_000);
    const dueSoon = await prisma.school.findMany({
      where: {
        deletedAt: null,
        subscriptionStatus: "ACTIVE",
        paidUntil: { not: null, lte: weekOut },
      },
      select: { id: true, name: true, paidUntil: true, monthlyFee: true },
      orderBy: { paidUntil: "asc" },
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
      mrr,
      unpriced,
      dueSoon: dueSoon.map((s) => ({
        ...s,
        monthlyFee: Number(s.monthlyFee ?? 0),
        overdueDays: s.paidUntil
          ? Math.max(0, Math.ceil((Date.now() - s.paidUntil.getTime()) / 86_400_000))
          : 0,
      })),
    };
  });
}

/**
 * What was actually COLLECTED, as opposed to what is owed.
 *
 * ⚠️ The console's headline said "Monthly revenue" and showed MRR — the sum of
 * every active school's `monthlyFee`. That is a projection: what they should
 * pay if they all pay. It is the most flattering number on the screen and the
 * one least likely to be true, and there was nothing anywhere showing the
 * money that had actually arrived.
 *
 * Every payment is already written down — `recordSubscriptionPayment` audits
 * `school.subscription.paid` with the fee that applied at the time, so the
 * history is a fact rather than a recomputation from today's price list. A
 * school that was on GH₵500 last year and GH₵800 now shows what it actually
 * paid each month.
 *
 * Cross-tenant by nature, so withBypass — the console belongs to no school.
 */
export type RevenueMonth = { month: string; label: string; amount: number; payments: number };

export async function getRevenue(months = 6) {
  return withBypass(async () => {
    const since = new Date();
    since.setMonth(since.getMonth() - (months - 1));
    since.setDate(1);
    since.setHours(0, 0, 0, 0);

    const rows = await prisma.auditLog.findMany({
      where: { action: "school.subscription.paid", createdAt: { gte: since } },
      select: { createdAt: true, after: true, schoolId: true },
      orderBy: { createdAt: "desc" },
    });

    const fmt = new Intl.DateTimeFormat("en-GB", { month: "short", year: "numeric" });
    const buckets = new Map<string, RevenueMonth>();
    for (let i = 0; i < months; i += 1) {
      const when = new Date(since);
      when.setMonth(since.getMonth() + i);
      const key = `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, "0")}`;
      buckets.set(key, { month: key, label: fmt.format(when), amount: 0, payments: 0 });
    }

    for (const row of rows) {
      const key = `${row.createdAt.getFullYear()}-${String(row.createdAt.getMonth() + 1).padStart(2, "0")}`;
      const bucket = buckets.get(key);
      if (!bucket) continue;
      // ⚠️ `amount` is whatever the fee WAS when the payment was taken. A null
      // means the school had no price set — it is a payment that happened, so
      // it is counted as one, but it adds nothing to the money.
      const after = (row.after ?? {}) as { amount?: string | null };
      bucket.amount += Number(after.amount ?? 0);
      bucket.payments += 1;
    }

    const series = [...buckets.values()];
    const thisMonth = series.at(-1)!;
    const lastMonth = series.at(-2) ?? null;

    return {
      series,
      thisMonth,
      lastMonth,
      /** Everything in the window, for "collected in the last N months". */
      total: series.reduce((sum, m) => sum + m.amount, 0),
      /** Payments with no price attached — a gap in the record, not revenue. */
      unpriced: rows.filter((r) => ((r.after ?? {}) as { amount?: string | null }).amount == null)
        .length,
    };
  });
}

/**
 * What the platform admin has DONE, across every tenant.
 *
 * The console could change a school's plan, suspend it and take its money, and
 * then showed no record of any of it — each action was audited into the
 * school's own trail, where the school can see it and the platform owner
 * cannot, because the console never reads a tenant's log.
 *
 * ⚠️ Only the actions the CONSOLE takes. A school's own bursar recording a fee
 * payment is that school's business and belongs on its own dashboard; mixing
 * the two would make this the busiest and least useful screen in the product.
 */
const CONSOLE_ACTIONS = ["school.provision", "school.subscription", "school.subscription.paid"];

export type PlatformEvent = {
  id: string;
  action: string;
  title: string;
  detail: string;
  actor: string;
  when: Date;
};

export async function getPlatformActivity(take = 12): Promise<PlatformEvent[]> {
  return withBypass(async () => {
    const rows = await prisma.auditLog.findMany({
      where: { action: { in: CONSOLE_ACTIONS } },
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        action: true,
        after: true,
        createdAt: true,
        actor: { select: { name: true, email: true } },
        school: { select: { name: true } },
      },
    });

    return rows.map((row) => {
      const after = (row.after ?? {}) as Record<string, unknown>;
      const school = row.school?.name ?? "a school";
      let title = "Changed a school";
      let detail = school;

      if (row.action === "school.provision") {
        title = "Provisioned a school";
        detail = `${school} · ${String(after.plan ?? "no plan").toLowerCase().replace(/_/g, " ")}`;
      } else if (row.action === "school.subscription.paid") {
        title = "Recorded a payment";
        detail = after.amount ? `${school} · GH₵${after.amount}` : school;
      } else if (row.action === "school.subscription") {
        title = "Changed the subscription";
        const plan = after.plan ? String(after.plan).toLowerCase().replace(/_/g, " ") : null;
        const status = after.subscriptionStatus
          ? String(after.subscriptionStatus).toLowerCase().replace(/_/g, " ")
          : null;
        detail = [school, plan, status].filter(Boolean).join(" · ");
      }

      return {
        id: row.id,
        action: row.action,
        title,
        detail,
        // The email, not the name: on this screen the question is WHICH admin.
        actor: row.actor?.email ?? row.actor?.name ?? "unknown",
        when: row.createdAt,
      };
    });
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
        paidUntil: true, monthlyFee: true,
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
      // Decimal is a Prisma object and does not cross into a client component;
      // the money leaves this layer as a number, like every other figure here.
      monthlyFee: school.monthlyFee === null ? null : Number(school.monthlyFee),
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

/** Turn a school's name into a URL key: "Hope Education Complex" → "hope-education-complex". */
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
