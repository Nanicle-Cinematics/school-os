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
import { allocateFifo, recalcInvoice, syncCarriedForward } from "@/lib/invoice-engine";
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
  setTenantContext({ schoolId: auth.schoolId });

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
    receiptNo = await tenantTransaction(auth.schoolId, async (tx) => {
      // Serialise payments for one student: two at once would both read the same
      // open balances and both allocate to them. Released at commit.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payment:" + studentId}))`;

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

      // A transaction id is unique to the school, whoever it was recorded against,
      // and a second payment with it is never legitimate: no override.
      if (method === "MOBILE_MONEY" && reference) {
        const sameReference = await tx.payment.findFirst({
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
        const recent = await tx.payment.findFirst({
          where: {
            studentId,
            amount,
            method: method as "CASH",
            status: "CONFIRMED",
            createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
          },
          select: { receiptNo: true },
        });
        if (recent) {
          throw new Error(`DUPLICATE:${recent.receiptNo}`);
        }
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
          paidAt,
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

      // Paying off an old invoice shrinks what the newer ones carry forward.
      await syncCarriedForward(tx, studentId);

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
