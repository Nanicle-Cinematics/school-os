import "server-only";

import { prisma } from "@/lib/prisma";

export async function getLedgerAccounts() {
  return prisma.ledgerAccount.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }],
    include: { _count: { select: { feeCategoriesAsIncome: true, expenseCategoriesAsExpense: true } } },
  });
}

export async function getCategoryAccountMappings() {
  const [feeCategories, expenseCategories, accounts] = await Promise.all([
    prisma.feeCategory.findMany({
      orderBy: { order: "asc" },
      select: { id: true, name: true, incomeAccountId: true },
    }),
    prisma.expenseCategory.findMany({
      orderBy: { order: "asc" },
      select: { id: true, name: true, expenseAccountId: true },
    }),
    prisma.ledgerAccount.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { order: "asc" }],
      select: { id: true, code: true, name: true, type: true },
    }),
  ]);
  return {
    feeCategories,
    expenseCategories,
    incomeAccounts: accounts.filter((a) => a.type === "INCOME"),
    expenseAccounts: accounts.filter((a) => a.type === "EXPENSE"),
  };
}
