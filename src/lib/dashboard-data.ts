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
