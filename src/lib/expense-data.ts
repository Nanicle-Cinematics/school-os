import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * What the cash book counts.
 *
 * ⚠️ PAID only — not "anything but CANCELLED", which is what this used to say.
 * DRAFT now means "spent, awaiting a second signature", so counting it would
 * put money in the net position that the school has not agreed to, and the
 * figure a proprietor checks against the drawer would be wrong in the one
 * direction that matters.
 *
 * APPROVED is in the enum and deliberately unused: sign-off here goes straight
 * from DRAFT to PAID, because a three-step requested/approved/paid flow is more
 * ceremony than a one-stream basic school will keep up, and a step everyone
 * skips is a step that lies.
 */
const COUNTED: Prisma.ExpenseWhereInput = { status: "PAID" };

export async function getExpenseList(filters: { termId?: string; categoryId?: string; q?: string }) {
  const where: Prisma.ExpenseWhereInput = {
    ...COUNTED,
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

  // Held for approval. Its own query rather than a filter on the list, because
  // it must appear whatever the user is filtering by — an expense nobody can
  // see is an expense nobody will sign.
  const pending = await prisma.expense.findMany({
    where: { status: "DRAFT", ...(filters.termId ? { termId: filters.termId } : {}) },
    orderBy: { spentAt: "asc" },
    include: {
      category: { select: { name: true } },
      recordedBy: { select: { name: true } },
    },
  });

  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  return {
    expenses,
    pending,
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
      where: { termId, ...COUNTED },
      _sum: { amount: true },
    }),
  ]);

  const income = collected._sum.amountPaid ?? new Prisma.Decimal(0);
  const outgoing = spent._sum.amount ?? new Prisma.Decimal(0);
  return { income, outgoing, net: income.sub(outgoing) };
}

/**
 * The Income & Expenditure Statement — the one document a proprietor can
 * print and hand to a board meeting or an auditor, rather than reading the
 * same numbers off three different screens.
 *
 * Deliberately reuses `getTermCashPosition` for income/expenditure/net rather
 * than re-deriving them: this statement can never disagree with the number
 * already shown on the cash-book dashboard, because it is the same query.
 * Income stays ONE line — "fees collected" — rather than broken out by fee
 * category, because a payment is allocated to an INVOICE, not to a category
 * within it, so any category split on the income side would be an invented
 * apportionment, not a recorded fact. Expenditure has no such problem: every
 * voucher already carries its own category.
 */
export async function getIncomeExpenditureStatement(termId: string) {
  const term = await prisma.term.findUniqueOrThrow({
    where: { id: termId },
    include: { academicYear: { select: { name: true } } },
  });
  const position = await getTermCashPosition(termId);
  const byCategory = await prisma.expense.groupBy({
    by: ["categoryId"],
    where: { termId, ...COUNTED },
    _sum: { amount: true },
  });
  const categories = await prisma.expenseCategory.findMany({
    orderBy: { order: "asc" },
  });
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  const expenditureByCategory = byCategory
    .map((row) => ({
      categoryId: row.categoryId,
      name: row.categoryId ? (categoryName.get(row.categoryId) ?? "Uncategorised") : "Uncategorised",
      total: row._sum.amount ?? new Prisma.Decimal(0),
    }))
    .sort((a, b) => Number(b.total) - Number(a.total));

  return {
    term,
    income: position.income,
    expenditureByCategory,
    expenditure: position.outgoing,
    net: position.net,
  };
}
