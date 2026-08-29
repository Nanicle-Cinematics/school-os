import "server-only";

import { prisma } from "@/lib/prisma";

const cedis = new Intl.NumberFormat("en-GH", {
  style: "currency",
  currency: "GHS",
  maximumFractionDigits: 0,
});

export function formatCedis(value: number) {
  return cedis.format(value);
}

/**
 * Every query here is tenant-scoped by the context requireAuth() installed, so
 * none of them pass schoolId explicitly — that is the point of the RLS setup.
 * Once DB_RLS=on, Postgres enforces it rather than trusting these callers.
 */
export async function getDashboard(schoolId: string) {
  const term = await prisma.term.findFirst({
    where: { schoolId, isCurrent: true },
    include: { academicYear: true },
  });

  const [students, staff, classGroups, boys, girls] = await Promise.all([
    prisma.student.count({ where: { schoolId, status: "ACTIVE" } }),
    prisma.staff.count({ where: { schoolId, status: "ACTIVE" } }),
    prisma.classGroup.count({ where: { schoolId } }),
    prisma.student.count({ where: { schoolId, status: "ACTIVE", gender: "MALE" } }),
    prisma.student.count({ where: { schoolId, status: "ACTIVE", gender: "FEMALE" } }),
  ]);

  const invoiceTotals = term
    ? await prisma.invoice.aggregate({
        where: { schoolId, termId: term.id, status: { not: "CANCELLED" } },
        _sum: { total: true, amountPaid: true, balance: true },
      })
    : null;

  const expenseTotal = term
    ? await prisma.expense.aggregate({
        where: { schoolId, termId: term.id, status: { not: "CANCELLED" } },
        _sum: { amount: true },
      })
    : null;

  const debtorCount = term
    ? await prisma.invoice.count({ where: { schoolId, termId: term.id, balance: { gt: 0 } } })
    : 0;

  const billed = Number(invoiceTotals?._sum.total ?? 0);
  const collected = Number(invoiceTotals?._sum.amountPaid ?? 0);
  const outstanding = Number(invoiceTotals?._sum.balance ?? 0);
  const spent = Number(expenseTotal?._sum.amount ?? 0);

  const recentPayments = await prisma.payment.findMany({
    where: { schoolId, status: "CONFIRMED" },
    orderBy: { paidAt: "desc" },
    take: 5,
    include: { student: { select: { firstName: true, lastName: true, admissionNo: true } } },
  });

  const topDebtors = term
    ? await prisma.invoice.findMany({
        where: { schoolId, termId: term.id, balance: { gt: 0 } },
        orderBy: { balance: "desc" },
        take: 5,
        include: {
          student: {
            select: {
              firstName: true,
              lastName: true,
              admissionNo: true,
              currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
            },
          },
        },
      })
    : [];

  const enrolmentByLevel = await prisma.level.findMany({
    where: { schoolId },
    orderBy: { order: "asc" },
    select: {
      id: true,
      name: true,
      classGroups: { select: { _count: { select: { students: true } } } },
    },
  });

  return {
    term,
    students,
    staff,
    classGroups,
    boys,
    girls,
    billed,
    collected,
    outstanding,
    spent,
    debtorCount,
    collectionRate: billed > 0 ? (collected / billed) * 100 : 0,
    recentPayments,
    topDebtors,
    enrolmentByLevel: enrolmentByLevel.map((level) => ({
      id: level.id,
      name: level.name,
      count: level.classGroups.reduce((sum, cg) => sum + cg._count.students, 0),
    })),
  };
}

export type AttentionItem = {
  /** Stable key, also used to pick the dot colour. */
  kind: "marking" | "fees" | "results" | "staffing";
  tag: string;
  title: string;
  detail: string;
  href: string;
  cta: string;
};

/**
 * The four things that actually stop a term finishing, computed rather than
 * listed. Each item is a sentence and the link that resolves it, so the
 * dashboard answers "what needs me today" instead of "how is the school going".
 *
 * Queries are counted deliberately: five, all aggregates. This runs on every
 * dashboard load over a link where a round trip is measured in seconds, so a
 * rule that needs a per-row query does not belong here.
 */
export async function getAttention(
  schoolId: string,
  term: { id: string; academicYearId: string } | null,
  fees: { outstanding: number; debtorCount: number },
): Promise<AttentionItem[]> {
  const items: AttentionItem[] = [];

  if (term) {
    // 1. Marking. An assessment is unfinished when fewer pupils have a score
    //    than are on the roster of the class it belongs to.
    const roster = await prisma.enrollment.groupBy({
      by: ["classGroupId"],
      where: { schoolId, academicYearId: term.academicYearId, status: "ACTIVE" },
      _count: { _all: true },
    });
    const rosterByClass = new Map(roster.map((row) => [row.classGroupId, row._count._all]));

    const assessments = await prisma.assessment.findMany({
      where: { schoolId, termId: term.id, status: { not: "APPROVED" } },
      select: { id: true, classGroupId: true, _count: { select: { scores: true } } },
    });
    const unfinished = assessments.filter(
      (a) => a._count.scores < (rosterByClass.get(a.classGroupId) ?? 0),
    );
    if (unfinished.length > 0) {
      const classes = new Set(unfinished.map((a) => a.classGroupId)).size;
      items.push({
        kind: "marking",
        tag: "Marking",
        title: `${unfinished.length} ${unfinished.length === 1 ? "sheet is" : "sheets are"} unfinished`,
        detail: `Across ${classes} ${classes === 1 ? "class" : "classes"} this term`,
        href: "/assessments/sheet",
        cta: "Open",
      });
    }

    // 3. Results computed but never published — a report card nobody can see.
    const pending = await prisma.termResult.groupBy({
      by: ["classGroupId"],
      where: { schoolId, termId: term.id, status: { not: "PUBLISHED" } },
      _count: { _all: true },
    });
    if (pending.length > 0) {
      const cards = pending.reduce((sum, row) => sum + row._count._all, 0);
      items.push({
        kind: "results",
        tag: "Results",
        title: `${cards} report ${cards === 1 ? "card is" : "cards are"} unpublished`,
        detail: `${pending.length} ${pending.length === 1 ? "class has" : "classes have"} results computed but not released`,
        href: "/results",
        cta: "Review",
      });
    }

    // 4. Staffing. A class whose level offers more subjects than it has
    //    teachers for has a mark sheet nobody can open.
    const classes = await prisma.classGroup.findMany({
      where: { schoolId },
      select: { id: true, levelId: true },
    });
    const offerings = await prisma.levelSubject.groupBy({
      by: ["levelId"],
      where: { schoolId },
      _count: { _all: true },
    });
    const offeredByLevel = new Map(offerings.map((row) => [row.levelId, row._count._all]));
    const assigned = await prisma.teachingAssignment.groupBy({
      by: ["classGroupId"],
      where: { schoolId, academicYearId: term.academicYearId },
      _count: { _all: true },
    });
    const assignedByClass = new Map(assigned.map((row) => [row.classGroupId, row._count._all]));

    const short = classes.filter(
      (c) => (assignedByClass.get(c.id) ?? 0) < (offeredByLevel.get(c.levelId) ?? 0),
    );
    if (short.length > 0) {
      items.push({
        kind: "staffing",
        tag: "Staffing",
        title: `${short.length} ${short.length === 1 ? "class is" : "classes are"} missing a teacher`,
        detail: "Some subjects have nobody assigned, so their marks cannot be entered",
        href: "/classes",
        cta: "Assign",
      });
    }
  }

  // 2. Fees. Already counted for the stat cards — not queried twice.
  if (fees.debtorCount > 0) {
    items.push({
      kind: "fees",
      tag: "Fees",
      title: `${fees.debtorCount} ${fees.debtorCount === 1 ? "family owes" : "families owe"} ${formatCedis(fees.outstanding)}`,
      detail: "Unpaid invoices for the current term",
      href: "/invoices?status=owing",
      cta: "Chase",
    });
  }

  return items;
}
