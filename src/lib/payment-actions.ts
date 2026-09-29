"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { allocateFifo, recalcInvoice } from "@/lib/invoice-engine";
import {
  cashAccountIdForMethod,
  findJournalEntryForSource,
  getCoreAccounts,
  postJournalEntry,
  reverseJournalEntry,
} from "@/lib/ledger-engine";
import { writeAudit } from "@/lib/audit";
import { readAttachment, storeAttachment } from "@/lib/attachments";
import { queueTransactionalSms } from "@/lib/transactional-sms";
import { TRANSACTIONAL } from "@/lib/message-defaults";
import { normalisePhone } from "@/lib/sms";

export type PaymentState = { error?: string; ok?: string };

export async function recordPayment(
  _prev: PaymentState,
  formData: FormData,
): Promise<PaymentState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const studentId = String(formData.get("studentId") ?? "");
  const amount = parseAmount(formData.get("amount"));
  const method = String(formData.get("method") ?? "CASH");
  const momoNetwork = String(formData.get("momoNetwork") ?? "");
  const reference = String(formData.get("reference") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  const paidAtRaw = String(formData.get("paidAt") ?? "");

  if (!studentId) {
    return { error: "Choose the student this payment is for." };
  }
  if (!amount) {
    return { error: "Enter a valid amount greater than zero." };
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
    receiptNo = await tenantTransaction(auth.schoolId, async (tx) => {
      const bankSlipUrl = upload.ok
        ? await storeAttachment(tx, auth.schoolId, auth.userId, upload)
        : null;

      const student = await tx.student.findUnique({
        where: { id: studentId },
        include: {
          guardians: { where: { isPrimary: true }, take: 1 },
          invoices: {
            where: { balance: { gt: 0 }, status: { not: "CANCELLED" } },
            orderBy: { issueDate: "asc" },
            select: { id: true, balance: true },
          },
        },
      });

      if (!student) {
        throw new Error("STUDENT_NOT_FOUND");
      }

      const receipt = await nextNumber(
        tx,
        auth.schoolId,
        "RECEIPT",
        takenProbes.receipt(tx, auth.schoolId),
      );

      const payment = await tx.payment.create({
        data: {
          schoolId: auth.schoolId,
          studentId,
          guardianId: student.guardians[0]?.guardianId ?? null,
          receiptNo: receipt,
          amount,
          method: method as "CASH",
          momoNetwork: method === "MOBILE_MONEY" && momoNetwork ? (momoNetwork as "MTN") : null,
          bankSlipUrl,
          reference: reference || null,
          note: note || null,
          status: "CONFIRMED",
          paidAt: paidAtRaw ? new Date(paidAtRaw) : new Date(),
          recordedByUserId: auth.userId,
        },
      });

      // Oldest invoice first — arrears clear before the current term.
      const allocations = allocateFifo(student.invoices, amount);
      for (const allocation of allocations) {
        await tx.paymentAllocation.create({
          data: {
            schoolId: auth.schoolId,
            paymentId: payment.id,
            invoiceId: allocation.invoiceId,
            amount: allocation.amount,
          },
        });
        await recalcInvoice(tx, allocation.invoiceId);
      }

      const allocated = allocations.reduce(
        (acc, a) => acc.add(a.amount),
        new Prisma.Decimal(0),
      );

      // Dr the account the method lands in / Cr Accounts Receivable, for the
      // FULL amount received — not just what was allocated. An overpayment
      // still reduced what the family is short by; this app has no separate
      // "customer deposit" liability to park the unallocated slice in.
      const core = await getCoreAccounts(tx, auth.schoolId);
      const cashLikeAccountId = cashAccountIdForMethod(core, payment.method);
      if (cashLikeAccountId && core.receivableAccountId) {
        await postJournalEntry(tx, auth.schoolId, {
          sourceType: "PAYMENT",
          sourceId: payment.id,
          memo: `Receipt ${receipt}`,
          actorUserId: auth.userId,
          lines: [
            { accountId: cashLikeAccountId, debit: amount },
            { accountId: core.receivableAccountId, credit: amount },
          ],
        });
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "payment.record",
        entity: "Payment",
        entityId: payment.id,
        after: {
          receiptNo: receipt,
          amount: amount.toString(),
          method,
          allocated: allocated.toString(),
          // Overpayment stays on the payment as unallocated credit rather than
          // being silently dropped — it belongs to the next invoice.
          unallocated: amount.sub(allocated).toString(),
        },
      });

      return receipt;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "STUDENT_NOT_FOUND") {
      return { error: "That student no longer exists." };
    }
    throw error;
  }

  // Best-effort receipt SMS, after the money is safely committed. Failure here
  // must never affect the payment, so queueTransactionalSms swallows its own
  // errors and no-ops unless SMS is switched on.
  const receiptDetails = await prisma.payment.findFirst({
    where: { schoolId: auth.schoolId, receiptNo },
    include: {
      guardian: { select: { id: true, firstName: true, lastName: true, phone: true } },
      student: {
        select: {
          firstName: true,
          lastName: true,
          invoices: {
            where: { status: { not: "CANCELLED" } },
            select: { balance: true },
          },
        },
      },
    },
  });

  if (receiptDetails?.guardian) {
    const balance = receiptDetails.student.invoices.reduce(
      (sum, invoice) => sum + Number(invoice.balance),
      0,
    );
    await queueTransactionalSms({
      schoolId: auth.schoolId,
      templateName: TRANSACTIONAL.paymentReceived,
      gate: "notifyOnPayment",
      toPhone: normalisePhone(receiptDetails.guardian.phone),
      studentId: receiptDetails.studentId,
      guardianId: receiptDetails.guardian.id,
      context: {
        school_name: auth.schoolName,
        guardian_name: `${receiptDetails.guardian.firstName} ${receiptDetails.guardian.lastName}`,
        student_name: `${receiptDetails.student.firstName} ${receiptDetails.student.lastName}`,
        amount: amount.toFixed(2),
        balance: balance.toFixed(2),
        receipt_no: receiptNo,
      },
    });
  }

  revalidatePath("/payments");
  revalidatePath("/invoices");
  revalidatePath("/dashboard");
  redirect(`/payments?receipt=${encodeURIComponent(receiptNo)}`);
}

export async function reversePayment(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const paymentId = String(formData.get("paymentId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!paymentId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
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
