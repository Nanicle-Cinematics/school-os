import "server-only";

import type { TenantTx } from "@/lib/prisma";

/**
 * The kinds of bill a Ghanaian basic school actually issues — a starting
 * point, not a standard, exactly as the fee items and expense headings are.
 * `TERMBILL` is load-bearing: `generateInvoicesForTerm` stamps it onto every
 * invoice it creates, so it must exist before a school's first term bill.
 */
export const DEFAULT_BILL_CODES = [
  { code: "TERMBILL", name: "Term Fees Bill", order: 1 },
  { code: "PTA", name: "PTA Bill", order: 2 },
  { code: "TRIP", name: "Trip / Excursion Bill", order: 3 },
  { code: "UNIFORM", name: "Uniform Bill", order: 4 },
  { code: "MISC", name: "Other Bill", order: 5 },
];

export type BillCodeDefaultsResult = { created: number; skipped: number };

/**
 * Give a school the standard bill codes. Idempotent on `code`, so it fills
 * gaps for a school provisioned before this existed and never touches a code
 * the school has already renamed — same shape as
 * `applyDefaultFinanceCategories`, and for the same reason: read then bulk
 * `createMany`, never a per-row existence check inside the provisioning
 * transaction.
 */
export async function applyDefaultBillCodes(
  tx: TenantTx,
  schoolId: string,
): Promise<BillCodeDefaultsResult> {
  const existing = await tx.billCode.findMany({
    where: { schoolId, code: { in: DEFAULT_BILL_CODES.map((c) => c.code) } },
    select: { code: true },
  });
  const codes = new Set(existing.map((c) => c.code));
  const missing = DEFAULT_BILL_CODES.filter((c) => !codes.has(c.code));

  if (missing.length === 0) {
    return { created: 0, skipped: existing.length };
  }

  const created = await tx.billCode.createMany({
    data: missing.map((code) => ({ schoolId, ...code })),
  });
  return { created: created.count, skipped: existing.length };
}
