"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type MomoNetwork, type PaymentMethod } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { recalcInvoice, syncCarriedForward } from "@/lib/invoice-engine";
import { bookPayment, sendReceiptSms } from "@/lib/payment-booking";
import { findJournalEntryForSource, reverseJournalEntry } from "@/lib/ledger-engine";
import { writeAudit } from "@/lib/audit";
import { readAttachment, storeAttachment } from "@/lib/attachments";

export type PaymentState = { error?: string; ok?: string; duplicate?: boolean };

const MAX_PAYMENT = new Prisma.Decimal("9999999999.99");
const METHODS = ["CASH", "BANK_TRANSFER", "BANK_DEPOSIT", "MOBILE_MONEY", "CARD", "CHEQUE"];
const MOMO_NETWORKS = ["MTN", "TELECEL", "AIRTELTIGO"];
/** The same student, amount and method inside this window is a double-press, not a second payment. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

export async function recordPayment(
  _prev: PaymentState,
  formData: FormData,
): Promise<PaymentState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const studentId = String(formData.get("studentId") ?? "");
  const amount = parseAmount(formData.get("amount"));
  const method = String(formData.get("method") ?? "CASH");
  const momoNetwork = String(formData.get("momoNetwork") ?? "");
  const reference = String(formData.get("reference") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const paidAtRaw = String(formData.get("paidAt") ?? "");
  const allowDuplicate = formData.get("allowDuplicate") === "on";

  if (!studentId) {
    return { error: "Choose the student this payment is for." };
  }
  if (!amount) {
    return { error: "Enter a valid amount greater than zero." };
  }
  // The column is Decimal(12,2); anything bigger is a typo, and would 500.
  if (amount.greaterThan(MAX_PAYMENT)) {
    return { error: "That amount is too large — check for an extra digit." };
  }
  if (!METHODS.includes(method)) {
    return { error: "Choose how the payment was made." };
  }
  if (momoNetwork && !MOMO_NETWORKS.includes(momoNetwork)) {
    return { error: "Choose a valid mobile money network." };
  }
  let paidAt = new Date();
  if (paidAtRaw) {
    paidAt = new Date(paidAtRaw);
    if (Number.isNaN(paidAt.getTime())) {
      return { error: "That payment date is not valid." };
    }
    if (paidAt.getTime() > Date.now() + 24 * 60 * 60 * 1000) {
      return { error: "A payment cannot be dated in the future." };
    }
  }
  if (method === "MOBILE_MONEY" && !reference) {
    return { error: "Mobile money payments need the transaction reference." };
  }

  /**
   * The bank slip or momo screenshot, read BEFORE the transaction opens — a
   * 4 MB parse inside it would hold the single pooled connection for the whole
   * read. Optional: cash across the counter has no slip to photograph.
   */
  const upload = await readAttachment(formData.get("slip"));
  if (!upload.ok && upload.error !== "No file") {
    return { error: upload.error };
  }

  let receiptNo = "";

  try {
    const booked = await tenantTransaction(auth.schoolId, (tx) =>
      bookPayment(tx, {
        schoolId: auth.schoolId,
        studentId,
        amount,
        method: method as PaymentMethod,
        momoNetwork: momoNetwork ? (momoNetwork as MomoNetwork) : null,
        reference: reference || null,
        note: note || null,
        paidAt,
        actorUserId: auth.userId,
        action: "payment.record",
        slip: upload.ok ? (t) => storeAttachment(t, auth.schoolId, auth.userId, upload) : undefined,
        beforeBooking: async (t) => {
          // A transaction id is unique to the school, whoever it was recorded against,
          // and a second payment with it is never legitimate: no override.
          if (method === "MOBILE_MONEY" && reference) {
            const sameReference = await t.payment.findFirst({
              where: { status: "CONFIRMED", method: "MOBILE_MONEY", reference },
              select: { receiptNo: true },
            });
            if (sameReference) {
              throw new Error(`REFERENCE:${sameReference.receiptNo}`);
            }
          }

          // Same student, amount and method moments ago is far more often a double
          // press than a second payment — but two identical fees paid back to back
          // do happen, so the office can confirm it is deliberate.
          if (!allowDuplicate) {
            const recent = await t.payment.findFirst({
              where: {
                studentId,
                amount,
                method: method as PaymentMethod,
                status: "CONFIRMED",
                createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
              },
              select: { receiptNo: true },
            });
            if (recent) {
              throw new Error(`DUPLICATE:${recent.receiptNo}`);
            }
          }
        },
      }),
    );
    receiptNo = booked.receiptNo;
  } catch (error) {
    if (error instanceof Error && error.message === "STUDENT_NOT_FOUND") {
      return { error: "That student no longer exists." };
    }
    if (error instanceof Error && error.message.startsWith("REFERENCE:")) {
      return {
        error: `That mobile money reference was already used for receipt ${error.message.slice(10)}. A transaction can only be recorded once.`,
      };
    }
    if (error instanceof Error && error.message.startsWith("DUPLICATE:")) {
      return {
        duplicate: true,
        error: `The same pupil paid the same sum the same way a moment ago (receipt ${error.message.slice(10)}). If this is a second payment, tick the box below and record it again; if not, it is already saved.`,
      };
    }
    throw error;
  }

  // Best-effort receipt SMS, after the money is safely committed.
  const texted = await sendReceiptSms({
    schoolId: auth.schoolId,
    schoolName: auth.schoolName,
    receiptNo,
    amount,
  });

  revalidatePath("/payments");
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/payments?receipt=${encodeURIComponent(receiptNo)}&sms=${texted}`);
}

export async function reversePayment(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const paymentId = String(formData.get("paymentId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!paymentId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    // One reversal at a time per payment, so two clicks cannot both pass the
    // "not yet reversed" check and reverse the journal entry twice.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payment:reverse:" + paymentId}))`;
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
      include: { allocations: true },
    });
    if (!payment || payment.status === "REVERSED") {
      return;
    }

    const invoiceIds = payment.allocations.map((a) => a.invoiceId);

    // Drop the allocations, then recompute each affected invoice so balances
    // and statuses roll back with the money.
    await tx.paymentAllocation.deleteMany({ where: { paymentId } });
    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: "REVERSED",
        reversedAt: new Date(),
        reversalReason: reason || "No reason given",
      },
    });
    for (const invoiceId of invoiceIds) {
      await recalcInvoice(tx, invoiceId);
    }
    await syncCarriedForward(tx, payment.studentId);

    // Best-effort: there is one only if the accounts were mapped when the
    // payment was originally recorded.
    const originalEntry = await findJournalEntryForSource(tx, auth.schoolId, "PAYMENT", paymentId);
    if (originalEntry) {
      await reverseJournalEntry(tx, auth.schoolId, originalEntry.id, {
        memo: `Reversal of ${payment.receiptNo}`,
        actorUserId: auth.userId,
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "payment.reverse",
      entity: "Payment",
      entityId: paymentId,
      before: { status: payment.status, amount: payment.amount.toString() },
      after: { status: "REVERSED", reason, invoicesAffected: invoiceIds.length },
    });
  });

  revalidatePath("/payments");
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
}
