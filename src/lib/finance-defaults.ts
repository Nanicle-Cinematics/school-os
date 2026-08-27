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

  for (const category of DEFAULT_FEE_CATEGORIES) {
    const existing = await tx.feeCategory.findFirst({ where: { schoolId, code: category.code } });
    if (existing) {
      result.skipped += 1;
      continue;
    }
    await tx.feeCategory.create({ data: { schoolId, ...category, isMandatory: true } });
    result.feeCategoriesCreated += 1;
  }

  for (const category of DEFAULT_EXPENSE_CATEGORIES) {
    const existing = await tx.expenseCategory.findFirst({
      where: { schoolId, code: category.code },
    });
    if (existing) {
      result.skipped += 1;
      continue;
    }
    await tx.expenseCategory.create({ data: { schoolId, ...category } });
    result.expenseCategoriesCreated += 1;
  }

  return result;
}
