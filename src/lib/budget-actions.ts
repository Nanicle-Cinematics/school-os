"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { LEADERSHIP } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { ownsExpenseCategories, ownsTerms } from "@/lib/ownership";
import { parseAmount } from "@/lib/money";
import { writeAudit } from "@/lib/audit";

export type BudgetState = { error?: string; ok?: string };

/**
 * Set or clear one heading's budget for a term.
 *
 * LEADERSHIP, not FINANCE: deciding what may be spent is the proprietor's job,
 * and the bursar who spends it should not also be the one who raises the
 * ceiling. That is the same separation the expense approval hold exists for.
 *
 * An empty amount DELETES the row rather than storing zero — "we have not
 * budgeted this" and "we have budgeted nothing for this" are different
 * sentences, and getBudgetVsActual renders them differently.
 */
export async function setBudget(_prev: BudgetState, formData: FormData): Promise<BudgetState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const termId = String(formData.get("termId") ?? "");
  const categoryId = String(formData.get("categoryId") ?? "");
  if (!termId || !categoryId) {
    return { error: "Pick a term and a heading." };
  }
  if (!(await ownsTerms([termId])) || !(await ownsExpenseCategories([categoryId]))) {
    return { error: "That term or heading was not found." };
  }

  const raw = String(formData.get("amount") ?? "").trim();
  const amount = raw ? parseAmount(raw) : null;
  if (raw && !amount) {
    return { error: "Enter an amount greater than zero, or leave it empty to remove the budget." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const category = await tx.expenseCategory.findUnique({
      where: { id: categoryId },
      select: { name: true },
    });
    if (!category) {
      throw new Error("CATEGORY_NOT_FOUND");
    }

    if (amount === null) {
      await tx.budget.deleteMany({ where: { termId, categoryId } });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "budget.clear",
        entity: "Budget",
        entityId: `${termId}:${categoryId}`,
        after: { category: category.name },
      });
      return;
    }

    await tx.budget.upsert({
      where: { termId_categoryId: { termId, categoryId } },
      create: {
        schoolId: auth.schoolId,
        termId,
        categoryId,
        amount,
        setByUserId: auth.userId,
      },
      update: { amount, setByUserId: auth.userId },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "budget.set",
      entity: "Budget",
      entityId: `${termId}:${categoryId}`,
      after: { category: category.name, amount: amount.toString() },
    });
  });

  revalidatePath("/expenses");
  return { ok: amount === null ? "Budget removed." : "Budget saved." };
}
