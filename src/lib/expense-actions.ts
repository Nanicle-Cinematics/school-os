"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { writeAudit } from "@/lib/audit";

export type ExpenseState = { error?: string; ok?: string };

export async function recordExpense(
  _prev: ExpenseState,
  formData: FormData,
): Promise<ExpenseState> {
  const auth = await requireRole(FINANCE);

  const categoryId = String(formData.get("categoryId") ?? "");
  const termId = String(formData.get("termId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const payee = String(formData.get("payee") ?? "").trim();
  const method = String(formData.get("method") ?? "CASH");
  const reference = String(formData.get("reference") ?? "").trim();
  const spentAtRaw = String(formData.get("spentAt") ?? "");
  const amount = parseAmount(formData.get("amount"));

  if (!description) {
    return { error: "Describe what the money was spent on." };
  }
  if (!amount) {
    return { error: "Enter a valid amount greater than zero." };
  }

  const voucherNo = await tenantTransaction(async (tx) => {
    const voucher = await nextNumber(
      tx,
      auth.schoolId,
      "VOUCHER",
      takenProbes.voucher(tx, auth.schoolId),
    );

    const expense = await tx.expense.create({
      data: {
        schoolId: auth.schoolId,
        categoryId: categoryId || null,
        termId: termId || null,
        voucherNo: voucher,
        description,
        amount,
        payee: payee || null,
        method: method as "CASH",
        reference: reference || null,
        status: "PAID",
        spentAt: spentAtRaw ? new Date(spentAtRaw) : new Date(),
        recordedByUserId: auth.userId,
      },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "expense.record",
      entity: "Expense",
      entityId: expense.id,
      after: { voucherNo: voucher, amount: amount.toString(), description, payee },
    });

    return voucher;
  });

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return { ok: `Recorded ${description} — voucher ${voucherNo}.` };
}

export async function cancelExpense(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  const expenseId = String(formData.get("expenseId") ?? "");
  if (!expenseId) {
    return;
  }

  await tenantTransaction(async (tx) => {
    const expense = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!expense) {
      return;
    }
    // Cancel, never delete — spend history has to stay auditable.
    await tx.expense.update({ where: { id: expenseId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "expense.cancel",
      entity: "Expense",
      entityId: expenseId,
      before: { status: expense.status, amount: expense.amount.toString() },
      after: { status: "CANCELLED" },
    });
  });

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
}
