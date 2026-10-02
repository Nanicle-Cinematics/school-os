import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type BudgetRow = {
  categoryId: string;
  name: string;
  budget: number | null;
  actual: number;
  variance: number | null;
  usedPct: number | null;
};

/**
 * Budget against actual, per expense heading, for one term.
 *
 * ⚠️ `budget: null` is NOT zero, and the difference is the whole point of the
 * screen. A heading nobody has budgeted is unbudgeted — "overspent by
 * everything" is a different sentence, and showing the second where the first
 * is true would have a proprietor chasing a variance that only means "we have
 * not decided yet".
 *
 * Actual counts PAID only, matching the cash book and the dashboard. Spending
 * held for approval is not yet the school's money gone, so it must not eat a
 * budget the head has not agreed to.
 *
 * Every active category appears whether or not it has either, because a heading
 * with no budget and no spend is exactly the row a proprietor setting a budget
 * is looking for.
 */
export async function getBudgetVsActual(termId: string): Promise<BudgetRow[]> {
  const categories = await prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });

  const budgets = await prisma.budget.findMany({
    where: { termId },
    select: { categoryId: true, amount: true },
  });

  const spent = await prisma.expense.groupBy({
    by: ["categoryId"],
    where: { termId, status: "PAID" },
    _sum: { amount: true },
  });

  const budgetBy = new Map(budgets.map((b) => [b.categoryId, Number(b.amount)]));
  const spentBy = new Map(
    spent.map((row) => [row.categoryId ?? "", Number(row._sum.amount ?? 0)]),
  );

  const rows = categories.map((category) => {
    const budget = budgetBy.has(category.id) ? (budgetBy.get(category.id) as number) : null;
    const actual = spentBy.get(category.id) ?? 0;
    return {
      categoryId: category.id,
      name: category.name,
      budget,
      actual,
      variance: budget === null ? null : budget - actual,
      // Guarded against a zero budget: a heading budgeted at nothing and spent
      // on is over, but dividing by it would render Infinity on the page.
      usedPct: budget === null ? null : budget === 0 ? (actual > 0 ? 100 : 0) : (actual / budget) * 100,
    };
  });

  // Spending with no category belongs in the totals too. It used to be dropped
  // (it matched no category row), so a school could overspend without a budget
  // line ever showing it.
  const uncategorised = spentBy.get("") ?? 0;
  if (uncategorised > 0) {
    rows.push({
      categoryId: "",
      name: "Uncategorised",
      budget: null,
      actual: uncategorised,
      variance: null,
      usedPct: null,
    });
  }

  return rows;
}

/** The one-line summary the proprietor reads first. */
export function budgetTotals(rows: BudgetRow[]) {
  const budgeted = rows.reduce((t, r) => t + (r.budget ?? 0), 0);
  const actual = rows.reduce((t, r) => t + r.actual, 0);
  // Only headings that HAVE a budget can be over it. Unbudgeted spending is
  // reported separately rather than folded in, because it is a different
  // problem: nobody decided, rather than somebody exceeded.
  const over = rows.filter((r) => r.budget !== null && r.actual > r.budget);
  const unbudgeted = rows.filter((r) => r.budget === null && r.actual > 0);
  return {
    budgeted,
    actual,
    remaining: budgeted - rows.filter((r) => r.budget !== null).reduce((t, r) => t + r.actual, 0),
    over,
    unbudgeted,
  };
}

export async function getBudgetsForTerm(termId: string) {
  return prisma.budget.findMany({
    where: { termId },
    include: { category: { select: { name: true } } },
    orderBy: { category: { order: "asc" } },
  });
}

export const ZERO = new Prisma.Decimal(0);
