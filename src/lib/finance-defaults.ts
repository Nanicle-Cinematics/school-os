import "server-only";

import type { TenantTx } from "@/lib/prisma";

/**
 * The bill lines a Ghanaian basic school actually charges, and the headings a
 * bursar's cash book actually uses.
 *
 * These exist for the same reason the GES curriculum does: a school that opens
 * to an empty list has to invent one before it can do anything, and the fee
 * screen is worse than the curriculum screen because a fee structure is priced
 * *per item* — with no items there is nothing to type an amount into, and the
 * form is a dead end rather than merely empty.
 *
 * A school renames, adds to or deletes these afterwards. They are a starting
 * point, not a standard: "PTA Levy" is near-universal, "ICT Levy" is not.
 */

export const DEFAULT_FEE_CATEGORIES = [
  { code: "TUITION", name: "Tuition", order: 1 },
  { code: "PTA", name: "PTA Levy", order: 2 },
  { code: "EXAM", name: "Examination Fee", order: 3 },
  { code: "FEEDING", name: "Feeding Fee", order: 4 },
  { code: "ICT", name: "ICT / Computer Levy", order: 5 },
  { code: "SPORTS", name: "Sports and Culture", order: 6 },
  { code: "STATIONERY", name: "Stationery and Printing", order: 7 },
];

export const DEFAULT_EXPENSE_CATEGORIES = [
  { code: "SALARIES", name: "Salaries and Allowances", order: 1 },
  { code: "UTILITIES", name: "Utilities (Light, Water)", order: 2 },
  { code: "MAINT", name: "Repairs and Maintenance", order: 3 },
  { code: "KITCHEN", name: "Feeding and Kitchen", order: 4 },
  { code: "STATIONERY", name: "Stationery and Printing", order: 5 },
  { code: "TRANSPORT", name: "Transport and Fuel", order: 6 },
  { code: "MISC", name: "Miscellaneous", order: 7 },
];

export type FinanceDefaultsResult = {
  feeCategoriesCreated: number;
  expenseCategoriesCreated: number;
  skipped: number;
};

/**
 * Give a school the standard fee items and expense headings.
 *
 * Idempotent on `code`, which is unique per school — so it fills gaps for a
 * school provisioned before this existed, and never renames or deletes an item
 * the school has already customised.
 */
export async function applyDefaultFinanceCategories(
  tx: TenantTx,
  schoolId: string,
): Promise<FinanceDefaultsResult> {
  const result: FinanceDefaultsResult = {
    feeCategoriesCreated: 0,
    expenseCategoriesCreated: 0,
    skipped: 0,
  };

  // Read then bulk-write, for the reason spelled out in ges-curriculum.ts: this
  // runs inside the provisioning transaction, over a single pooled connection,
  // and a per-row existence check turns fourteen items into twenty-eight
  // sequential round trips for no benefit.

  const existingFees = await tx.feeCategory.findMany({
    where: { schoolId, code: { in: DEFAULT_FEE_CATEGORIES.map((c) => c.code) } },
    select: { code: true },
  });
  const feeCodes = new Set(existingFees.map((c) => c.code));
  result.skipped += existingFees.length;

  const missingFees = DEFAULT_FEE_CATEGORIES.filter((c) => !feeCodes.has(c.code));
  if (missingFees.length > 0) {
    const created = await tx.feeCategory.createMany({
      data: missingFees.map((category) => ({ schoolId, ...category, isMandatory: true })),
    });
    result.feeCategoriesCreated += created.count;
  }

  const existingExpenses = await tx.expenseCategory.findMany({
    where: { schoolId, code: { in: DEFAULT_EXPENSE_CATEGORIES.map((c) => c.code) } },
    select: { code: true },
  });
  const expenseCodes = new Set(existingExpenses.map((c) => c.code));
  result.skipped += existingExpenses.length;

  const missingExpenses = DEFAULT_EXPENSE_CATEGORIES.filter((c) => !expenseCodes.has(c.code));
  if (missingExpenses.length > 0) {
    const created = await tx.expenseCategory.createMany({
      data: missingExpenses.map((category) => ({ schoolId, ...category })),
    });
    result.expenseCategoriesCreated += created.count;
  }

  return result;
}
