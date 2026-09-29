import "server-only";

import { prisma } from "@/lib/prisma";

/** Asset and Expense accounts run a normal DEBIT balance; Liability, Equity and Income run a normal CREDIT balance — standard bookkeeping convention, so a credit-heavy Income account reads as a positive figure rather than a confusing negative one. */
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

export async function getLedgerAccounts() {
  const [accounts, postings, coreSettings] = await Promise.all([
    prisma.ledgerAccount.findMany({
      orderBy: [{ type: "asc" }, { order: "asc" }],
      include: {
        _count: {
          select: {
            feeCategoriesAsIncome: true,
            expenseCategoriesAsExpense: true,
            journalLines: true,
          },
        },
      },
    }),
    prisma.journalLine.groupBy({ by: ["accountId"], _sum: { debit: true, credit: true } }),
    // Plain ids, not a Prisma relation (see the schema comment on
    // SchoolSettings) — counted here by hand instead of a _count include.
    prisma.schoolSettings.findFirst({
      select: {
        cashAccountId: true,
        bankAccountId: true,
        momoAccountId: true,
        receivableAccountId: true,
        payableAccountId: true,
      },
    }),
  ]);

  const postingByAccount = new Map(postings.map((p) => [p.accountId, p]));
  const coreAccountIds = new Set(
    [
      coreSettings?.cashAccountId,
      coreSettings?.bankAccountId,
      coreSettings?.momoAccountId,
      coreSettings?.receivableAccountId,
      coreSettings?.payableAccountId,
    ].filter((id): id is string => Boolean(id)),
  );

  return accounts.map((account) => {
    const posting = postingByAccount.get(account.id);
    const debit = Number(posting?._sum.debit ?? 0);
    const credit = Number(posting?._sum.credit ?? 0);
    const balance = DEBIT_NORMAL.has(account.type) ? debit - credit : credit - debit;
    return { ...account, balance, isCoreAccount: coreAccountIds.has(account.id) };
  });
}

export async function getCoreAccountSettings() {
  const [settings, assetAccounts, liabilityAccounts] = await Promise.all([
    prisma.schoolSettings.findFirst({
      select: {
        cashAccountId: true,
        bankAccountId: true,
        momoAccountId: true,
        receivableAccountId: true,
        payableAccountId: true,
      },
    }),
    prisma.ledgerAccount.findMany({
      where: { isActive: true, type: "ASSET" },
      orderBy: { order: "asc" },
      select: { id: true, code: true, name: true },
    }),
    prisma.ledgerAccount.findMany({
      where: { isActive: true, type: "LIABILITY" },
      orderBy: { order: "asc" },
      select: { id: true, code: true, name: true },
    }),
  ]);
  return {
    cashAccountId: settings?.cashAccountId ?? "",
    bankAccountId: settings?.bankAccountId ?? "",
    momoAccountId: settings?.momoAccountId ?? "",
    receivableAccountId: settings?.receivableAccountId ?? "",
    payableAccountId: settings?.payableAccountId ?? "",
    assetAccounts,
    liabilityAccounts,
  };
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
