"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE, LEADERSHIP, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { nextNumber, takenProbes } from "@/lib/sequences";
import {
  cashAccountIdForMethod,
  findJournalEntryForSource,
  getCoreAccounts,
  postJournalEntry,
  reverseJournalEntry,
} from "@/lib/ledger-engine";
import { writeAudit } from "@/lib/audit";
import { readAttachment, storeAttachment } from "@/lib/attachments";
import type { TenantTx } from "@/lib/prisma";
import type { PaymentMethod, Prisma } from "@prisma/client";

export type ExpenseState = { error?: string; ok?: string };

/**
 * Dr the expense account (via its category) / Cr the cash-like account for
 * the method paid — only when both are mapped. Called at the one moment an
 * expense actually counts as spent: creation with no approval needed, or
 * approval of one that was held. See ledger-engine.ts's additive rule.
 */
async function postExpenseIfMapped(
  tx: TenantTx,
  schoolId: string,
  expense: { id: string; voucherNo: string; amount: Prisma.Decimal; method: PaymentMethod; categoryId: string | null },
  actorUserId: string,
) {
  if (!expense.categoryId) {
    return;
  }
  const category = await tx.expenseCategory.findUnique({
    where: { id: expense.categoryId },
    select: { expenseAccountId: true },
  });
  if (!category?.expenseAccountId) {
    return;
  }
  const core = await getCoreAccounts(tx, schoolId);
  const cashLikeAccountId = cashAccountIdForMethod(core, expense.method);
  if (!cashLikeAccountId) {
    return;
  }
  await postJournalEntry(tx, schoolId, {
    sourceType: "EXPENSE",
    sourceId: expense.id,
    memo: `Expense ${expense.voucherNo}`,
    actorUserId,
    lines: [
      { accountId: category.expenseAccountId, debit: expense.amount },
      { accountId: cashLikeAccountId, credit: expense.amount },
    ],
  });
}

export async function recordExpense(
  _prev: ExpenseState,
  formData: FormData,
): Promise<ExpenseState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

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

  /**
   * Does this one need a second signature?
   *
   * Three things have to be true, and the third is the one that keeps the rule
   * humane: the school has SET a threshold (null means it never asked for
   * approvals), the amount reaches it, and the person recording it is not
   * already an approver. A proprietor who is also the bursar would otherwise be
   * made to approve their own chalk, which is a workflow nobody follows for
   * long — and a control everyone routes around is worse than none, because it
   * looks like one on the screen.
   */
  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId: auth.schoolId },
    select: { expenseApprovalThreshold: true },
  });
  const threshold = settings?.expenseApprovalThreshold ?? null;
  const needsApproval =
    threshold !== null &&
    amount.gte(threshold) &&
    !canAccess(auth.roles, LEADERSHIP);

  /**
   * The receipt photo, read BEFORE the transaction opens.
   *
   * A 4 MB upload parsed inside the transaction holds the single pooled
   * connection open for the whole read, and on this link that is the difference
   * between a voucher and a P2028. "No file" is not an error — attaching one is
   * optional, and a bursar with no camera to hand must still be able to record
   * the spend.
   */
  const upload = await readAttachment(formData.get("receipt"));
  if (!upload.ok && upload.error !== "No file") {
    return { error: upload.error };
  }

  const voucherNo = await tenantTransaction(auth.schoolId, async (tx) => {
    const receiptUrl = upload.ok
      ? await storeAttachment(tx, auth.schoolId, auth.userId, upload)
      : null;

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
        receiptUrl,
        // DRAFT is "spent, awaiting sign-off" — deliberately NOT counted in the
        // cash book until approved, so the net position never shows money the
        // school has not agreed to.
        status: needsApproval ? "DRAFT" : "PAID",
        spentAt: spentAtRaw ? new Date(spentAtRaw) : new Date(),
        recordedByUserId: auth.userId,
      },
    });

    if (!needsApproval) {
      await postExpenseIfMapped(tx, auth.schoolId, expense, auth.userId);
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "expense.record",
      entity: "Expense",
      entityId: expense.id,
      after: {
        voucherNo: voucher,
        amount: amount.toString(),
        description,
        payee,
        awaitingApproval: needsApproval,
      },
    });

    return voucher;
  });

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  return {
    ok: needsApproval
      ? `Recorded ${description} — voucher ${voucherNo}. It needs approval before it counts.`
      : `Recorded ${description} — voucher ${voucherNo}.`,
  };
}

/**
 * Sign off an expense that was held for approval.
 *
 * LEADERSHIP only, and it refuses the recorder's own voucher even when they
 * hold the role: a second signature that can be your own is not a second
 * signature. A proprietor who records their own spending never triggers the
 * hold in the first place (see needsApproval above), so this only ever bites
 * the case it should.
 */
export async function approveExpense(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("expenseId") ?? "");
  if (!id) {
    redirect("/expenses?error=missing");
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const expense = await tx.expense.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        voucherNo: true,
        amount: true,
        recordedByUserId: true,
        method: true,
        categoryId: true,
      },
    });
    if (!expense) {
      redirect("/expenses?error=missing");
    }
    if (expense.status !== "DRAFT") {
      // Already approved, or cancelled. Approving twice would stamp a new
      // signature over the original and lose who actually signed.
      redirect("/expenses?error=not-pending");
    }
    if (expense.recordedByUserId === auth.userId) {
      redirect("/expenses?error=own");
    }

    await tx.expense.update({
      where: { id },
      data: { status: "PAID", approvedByUserId: auth.userId, approvedAt: new Date() },
    });

    // Only posted now — a DRAFT expense held for approval never counted in
    // the cash book, so it never posted either.
    await postExpenseIfMapped(tx, auth.schoolId, expense, auth.userId);

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "expense.approve",
      entity: "Expense",
      entityId: id,
      after: { voucherNo: expense.voucherNo, amount: expense.amount.toString() },
    });
  });

  revalidatePath("/expenses");
  revalidatePath("/dashboard");
  redirect("/expenses?approved=1");
}

export async function cancelExpense(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const expenseId = String(formData.get("expenseId") ?? "");
  if (!expenseId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const expense = await tx.expense.findUnique({ where: { id: expenseId } });
    if (!expense) {
      return;
    }
    // Cancel, never delete — spend history has to stay auditable.
    await tx.expense.update({ where: { id: expenseId }, data: { status: "CANCELLED" } });

    // Only a PAID expense could have posted — a DRAFT one never did.
    if (expense.status === "PAID") {
      const originalEntry = await findJournalEntryForSource(tx, auth.schoolId, "EXPENSE", expenseId);
      if (originalEntry) {
        await reverseJournalEntry(tx, auth.schoolId, originalEntry.id, {
          memo: `Reversal of ${expense.voucherNo}`,
          actorUserId: auth.userId,
        });
      }
    }

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
