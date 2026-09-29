import "server-only";

import type { TenantTx } from "@/lib/prisma";
import { DEFAULT_FEE_CATEGORIES, DEFAULT_EXPENSE_CATEGORIES } from "@/lib/finance-defaults";

/**
 * A starting chart of accounts, not a standard: five core accounts every
 * school needs (where money sits, and what it owes/is owed), plus one income
 * account per default fee item and one expense account per default expense
 * heading — so a school that applies both default sets gets a coherent set of
 * accounts to post against, not just codes with nowhere to post.
 */
export const DEFAULT_CORE_ACCOUNTS: { code: string; name: string; type: "ASSET" | "LIABILITY" | "EQUITY"; order: number }[] = [
  { code: "CASH", name: "Cash in hand", type: "ASSET", order: 1 },
  { code: "BANK", name: "Bank", type: "ASSET", order: 2 },
  { code: "MOMO", name: "Mobile Money", type: "ASSET", order: 3 },
  { code: "AR", name: "Accounts Receivable (fees owed)", type: "ASSET", order: 4 },
  { code: "AP", name: "Accounts Payable (owed to suppliers)", type: "LIABILITY", order: 5 },
  { code: "EQUITY", name: "Owner's Equity", type: "EQUITY", order: 6 },
];

/** One income account per default fee item — code prefixed so it can't collide with the fee item's own code. */
export const DEFAULT_INCOME_ACCOUNTS = DEFAULT_FEE_CATEGORIES.map((c, i) => ({
  code: `INC_${c.code}`,
  name: `${c.name} Income`,
  type: "INCOME" as const,
  order: 100 + i,
  feeCategoryCode: c.code,
}));

/** One expense account per default expense heading. */
export const DEFAULT_EXPENSE_ACCOUNTS = DEFAULT_EXPENSE_CATEGORIES.map((c, i) => ({
  code: `EXP_${c.code}`,
  name: c.name,
  type: "EXPENSE" as const,
  order: 200 + i,
  expenseCategoryCode: c.code,
}));

export type LedgerDefaultsResult = { accountsCreated: number; linksSet: number };

/**
 * Give a school the standard chart of accounts, and link it to whichever
 * default fee items / expense headings already exist by code.
 *
 * Idempotent on `code`, same shape as `applyDefaultFinanceCategories`: read
 * then bulk `createMany`, never a per-row existence check inside the
 * provisioning transaction. Linking a fee/expense category to its account is
 * done only where the category exists and is not already linked — a school
 * that has already pointed "Tuition" at a different account keeps its choice.
 */
export async function applyDefaultChartOfAccounts(
  tx: TenantTx,
  schoolId: string,
): Promise<LedgerDefaultsResult> {
  const wanted = [
    ...DEFAULT_CORE_ACCOUNTS.map(({ code, name, type, order }) => ({ code, name, type, order })),
    ...DEFAULT_INCOME_ACCOUNTS.map(({ code, name, type, order }) => ({ code, name, type, order })),
    ...DEFAULT_EXPENSE_ACCOUNTS.map(({ code, name, type, order }) => ({ code, name, type, order })),
  ];

  const existing = await tx.ledgerAccount.findMany({
    where: { schoolId, code: { in: wanted.map((a) => a.code) } },
    select: { code: true },
  });
  const existingCodes = new Set(existing.map((a) => a.code));
  const missing = wanted.filter((a) => !existingCodes.has(a.code));

  let accountsCreated = 0;
  if (missing.length > 0) {
    const created = await tx.ledgerAccount.createMany({
      data: missing.map((a) => ({ schoolId, ...a })),
    });
    accountsCreated = created.count;
  }

  // Link fee/expense categories to their default account, where both exist
  // and the category isn't already pointed somewhere.
  const [feeCategories, expenseCategories, incomeAccounts, expenseAccounts] = await Promise.all([
    tx.feeCategory.findMany({ where: { schoolId, incomeAccountId: null }, select: { id: true, code: true } }),
    tx.expenseCategory.findMany({
      where: { schoolId, expenseAccountId: null },
      select: { id: true, code: true },
    }),
    tx.ledgerAccount.findMany({
      where: { schoolId, code: { in: DEFAULT_INCOME_ACCOUNTS.map((a) => a.code) } },
      select: { id: true, code: true },
    }),
    tx.ledgerAccount.findMany({
      where: { schoolId, code: { in: DEFAULT_EXPENSE_ACCOUNTS.map((a) => a.code) } },
      select: { id: true, code: true },
    }),
  ]);

  const incomeAccountByFeeCode = new Map(
    DEFAULT_INCOME_ACCOUNTS.map((a) => [
      a.feeCategoryCode,
      incomeAccounts.find((acc) => acc.code === a.code)?.id,
    ]),
  );
  const expenseAccountByExpenseCode = new Map(
    DEFAULT_EXPENSE_ACCOUNTS.map((a) => [
      a.expenseCategoryCode,
      expenseAccounts.find((acc) => acc.code === a.code)?.id,
    ]),
  );

  let linksSet = 0;
  for (const category of feeCategories) {
    const accountId = incomeAccountByFeeCode.get(category.code);
    if (accountId) {
      await tx.feeCategory.update({ where: { id: category.id }, data: { incomeAccountId: accountId } });
      linksSet += 1;
    }
  }
  for (const category of expenseCategories) {
    const accountId = expenseAccountByExpenseCode.get(category.code);
    if (accountId) {
      await tx.expenseCategory.update({
        where: { id: category.id },
        data: { expenseAccountId: accountId },
      });
      linksSet += 1;
    }
  }

  return { accountsCreated, linksSet };
}
