import "server-only";

import { journalActivityPerAccount } from "@/lib/scoped-counts";
import { prisma } from "@/lib/prisma";

/** Asset and Expense accounts run a normal DEBIT balance; Liability, Equity and Income run a normal CREDIT balance — standard bookkeeping convention, so a credit-heavy Income account reads as a positive figure rather than a confusing negative one. */
const DEBIT_NORMAL = new Set(["ASSET", "EXPENSE"]);

export async function getLedgerAccounts() {
  // Accounts first: the postings are read for THESE accounts only, through the account index. This was one
  // `Promise.all` that grouped the WHOLE journal-line table (every school's) and counted it again per account.
  const accounts = await prisma.ledgerAccount.findMany({
    orderBy: [{ type: "asc" }, { order: "asc" }],
    include: {
      // Two small tables. The journal-line count is taken below from the same grouped read as the totals.
      _count: { select: { feeCategoriesAsIncome: true, expenseCategoriesAsExpense: true } },
    },
  });
  const activity = await journalActivityPerAccount(accounts.map((account) => account.id));
  // Plain ids, not a Prisma relation (see the schema comment on
  // SchoolSettings) — counted here by hand instead of a _count include.
  const coreSettings = await prisma.schoolSettings.findFirst({
    select: {
      cashAccountId: true,
      bankAccountId: true,
      momoAccountId: true,
      receivableAccountId: true,
      payableAccountId: true,
    },
  });

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
    const posting = activity.get(account.id);
    const debit = posting?.debit ?? 0;
    const credit = posting?.credit ?? 0;
    const balance = DEBIT_NORMAL.has(account.type) ? debit - credit : credit - debit;
    return {
      ...account,
      // The shape the page already reads: the same three counts, the journal-line one now from the scoped read.
      _count: { ...account._count, journalLines: posting?.lines ?? 0 },
      balance,
      isCoreAccount: coreAccountIds.has(account.id),
    };
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
