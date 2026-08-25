import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getExpenseList(filters: { termId?: string; categoryId?: string; q?: string }) {
  const where: Prisma.ExpenseWhereInput = {
    status: { not: "CANCELLED" },
    ...(filters.termId ? { termId: filters.termId } : {}),
    ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
    ...(filters.q
      ? {
          OR: [
            { voucherNo: { contains: filters.q, mode: "insensitive" } },
            { description: { contains: filters.q, mode: "insensitive" } },
            { payee: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [expenses, totals, byCategory, categories, terms] = await Promise.all([
    prisma.expense.findMany({
      where,
      orderBy: { spentAt: "desc" },
      take: 200,
      include: {
        category: { select: { name: true } },
        recordedBy: { select: { name: true } },
      },
    }),
    prisma.expense.aggregate({ where, _sum: { amount: true }, _count: true }),
    prisma.expense.groupBy({
      by: ["categoryId"],
      where,
      _sum: { amount: true },
    }),
    prisma.expenseCategory.findMany({ where: { isActive: true }, orderBy: { order: "asc" } }),
    prisma.term.findMany({
      orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
      include: { academicYear: { select: { name: true } } },
      take: 12,
    }),
  ]);

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return {
    expenses,
    categories,
    terms,
    count: totals._count,
    total: totals._sum.amount ?? new Prisma.Decimal(0),
    byCategory: byCategory
      .map((row) => ({
        categoryId: row.categoryId,
        name: row.categoryId ? (categoryName.get(row.categoryId) ?? "Uncategorised") : "Uncategorised",
        total: row._sum.amount ?? new Prisma.Decimal(0),
      }))
      .sort((a, b) => Number(b.total) - Number(a.total)),
  };
}

/** Income vs expenditure for a term — the number a proprietor actually asks for. */
export async function getTermCashPosition(termId: string) {
  const [collected, spent] = await Promise.all([
    prisma.invoice.aggregate({
      where: { termId, status: { not: "CANCELLED" } },
      _sum: { amountPaid: true },
    }),
    prisma.expense.aggregate({
      where: { termId, status: { not: "CANCELLED" } },
      _sum: { amount: true },
    }),
  ]);

  const income = collected._sum.amountPaid ?? new Prisma.Decimal(0);
  const outgoing = spent._sum.amount ?? new Prisma.Decimal(0);
  return { income, outgoing, net: income.sub(outgoing) };
}
