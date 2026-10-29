import "server-only";

import { Prisma, type MomoNetwork, type PaymentMethod } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { prisma } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { allocateFifo, netOutstanding, recalcInvoice, syncCarriedForward } from "@/lib/invoice-engine";
import { cashAccountIdForMethod, getCoreAccounts, postJournalEntry } from "@/lib/ledger-engine";
import { writeAudit } from "@/lib/audit";
import { queueTransactionalSms, type TextOutcome } from "@/lib/transactional-sms";
import { TRANSACTIONAL } from "@/lib/message-defaults";
import { normalisePhone } from "@/lib/sms";

/**
 * The one way money is booked.
 *
 * It lived inside `recordPayment`, which is a server action with a signed-in bursar behind it. A
 * parent's online payment arrives from Paystack's webhook with NO session, and a second copy of the
 * allocate / ledger / audit sequence would have drifted from the first the first time either was
 * edited. So the sequence is here, taking a transaction and a school, and both callers use it.
 *
 * What it does, in order, all in the caller's transaction so it commits or rolls back as one:
 * lock this pupil's payments, find the pupil and their open invoices, run the caller's own checks,
 * take a receipt number, write the payment, allocate it oldest invoice first, recompute those
 * invoices and what the later ones carry forward, post the ledger entry for the FULL amount, and
 * write the audit row.
 *
 * Deliberately NOT in here: reading a request, the SMS (after commit, never inside), and any rule
 * about WHO may book (a role for the office, a verified Paystack transaction for the webhook).
 */
export type BookPaymentInput = {
  schoolId: string;
  studentId: string;
  amount: Prisma.Decimal;
  method: PaymentMethod;
  momoNetwork: MomoNetwork | null;
  reference: string | null;
  note: string | null;
  paidAt: Date;
  /** The signed-in user, or null for money that arrived by itself (a webhook). */
  actorUserId: string | null;
  providerRef?: string | null;
  providerStatus?: string | null;
  /** "payment.record" for the office; "payment.online" for Paystack. Each needs a phrase on the dashboard. */
  action: string;
  /** Stored before the pupil is read, as the original did: the bursar's slip photo. */
  slip?: (tx: TenantTx) => Promise<string | null>;
  /** The caller's own refusals (duplicate reference, double press). Throw to refuse; nothing is written yet. */
  beforeBooking?: (tx: TenantTx) => Promise<void>;
};

export type BookedPayment = {
  paymentId: string;
  receiptNo: string;
  allocated: Prisma.Decimal;
};

export async function bookPayment(tx: TenantTx, input: BookPaymentInput): Promise<BookedPayment> {
  const { schoolId, studentId, amount } = input;

  // Serialise payments for one student: two at once would both read the same open balances and
  // both allocate to them. Released at commit.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"payment:" + studentId}))`;

  const bankSlipUrl = input.slip ? await input.slip(tx) : null;

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

  if (input.beforeBooking) {
    await input.beforeBooking(tx);
  }

  const receipt = await nextNumber(tx, schoolId, "RECEIPT", takenProbes.receipt(tx, schoolId));

  const payment = await tx.payment.create({
    data: {
      schoolId,
      studentId,
      guardianId: student.guardians[0]?.guardianId ?? null,
      receiptNo: receipt,
      amount,
      method: input.method,
      momoNetwork: input.method === "MOBILE_MONEY" ? input.momoNetwork : null,
      bankSlipUrl,
      reference: input.reference,
      providerRef: input.providerRef ?? null,
      providerStatus: input.providerStatus ?? null,
      note: input.note,
      status: "CONFIRMED",
      paidAt: input.paidAt,
      recordedByUserId: input.actorUserId,
    },
  });

  // Oldest invoice first — arrears clear before the current term.
  const allocations = allocateFifo(student.invoices, amount);
  for (const allocation of allocations) {
    await tx.paymentAllocation.create({
      data: { schoolId, paymentId: payment.id, invoiceId: allocation.invoiceId, amount: allocation.amount },
    });
    await recalcInvoice(tx, allocation.invoiceId);
  }

  // Paying off an old invoice shrinks what the newer ones carry forward.
  await syncCarriedForward(tx, studentId);

  const allocated = allocations.reduce((acc, a) => acc.add(a.amount), new Prisma.Decimal(0));

  // Dr the account the method lands in / Cr Accounts Receivable, for the FULL amount received — not
  // just what was allocated. An overpayment still reduced what the family is short by; this app has
  // no separate "customer deposit" liability to park the unallocated slice in.
  const core = await getCoreAccounts(tx, schoolId);
  const cashLikeAccountId = cashAccountIdForMethod(core, payment.method);
  if (cashLikeAccountId && core.receivableAccountId) {
    await postJournalEntry(tx, schoolId, {
      sourceType: "PAYMENT",
      sourceId: payment.id,
      memo: `Receipt ${receipt}`,
      actorUserId: input.actorUserId,
      lines: [
        { accountId: cashLikeAccountId, debit: amount },
        { accountId: core.receivableAccountId, credit: amount },
      ],
    });
  }

  await writeAudit(tx, {
    schoolId,
    actorUserId: input.actorUserId,
    action: input.action,
    entity: "Payment",
    entityId: payment.id,
    after: {
      receiptNo: receipt,
      amount: amount.toString(),
      method: input.method,
      allocated: allocated.toString(),
      // Overpayment stays on the payment as unallocated credit rather than being silently dropped —
      // it belongs to the next invoice.
      unallocated: amount.sub(allocated).toString(),
      ...(input.providerRef ? { providerRef: input.providerRef } : {}),
    },
  });

  return { paymentId: payment.id, receiptNo: receipt, allocated };
}

/**
 * The receipt text, best-effort and AFTER the money has committed. Failure here must never affect
 * the payment, so `queueTransactionalSms` swallows its own errors and no-ops unless SMS is on.
 *
 * Returns who it went to, or why it did not, because a text that never left is as silent to the
 * office as it is to the parent. Must run inside a tenant context for `schoolId`.
 */
export async function sendReceiptSms(args: {
  schoolId: string;
  schoolName: string;
  receiptNo: string;
  amount: Prisma.Decimal;
}): Promise<TextOutcome | "noGuardian"> {
  const details = await prisma.payment.findFirst({
    where: { schoolId: args.schoolId, receiptNo: args.receiptNo },
    include: {
      guardian: { select: { id: true, firstName: true, lastName: true, phone: true } },
      student: {
        select: {
          firstName: true,
          lastName: true,
          invoices: {
            where: { status: { not: "CANCELLED" } },
            select: { total: true, broughtForward: true },
          },
          payments: {
            where: { reversedAt: null, status: "CONFIRMED" },
            select: { amount: true },
          },
        },
      },
    },
  });
  if (!details?.guardian) {
    return "noGuardian";
  }

  /**
   * ⚠️ NOT a sum of invoice balances. Each term's invoice carries the last one's unpaid balance
   * forward, so summing counted the same arrears once per term and told a parent with last term's
   * debt that they owed far more than they did — in a text headed "we have received".
   * netOutstanding is the figure the debtor messages and the parent portal already use.
   */
  const balance = netOutstanding(details.student.invoices, details.student.payments);
  return queueTransactionalSms({
    schoolId: args.schoolId,
    templateName: TRANSACTIONAL.paymentReceived,
    gate: "notifyOnPayment",
    toPhone: normalisePhone(details.guardian.phone),
    studentId: details.studentId,
    guardianId: details.guardian.id,
    context: {
      school_name: args.schoolName,
      guardian_name: `${details.guardian.firstName} ${details.guardian.lastName}`,
      student_name: `${details.student.firstName} ${details.student.lastName}`,
      amount: args.amount.toFixed(2),
      balance: balance.toFixed(2),
      receipt_no: args.receiptNo,
    },
  });
}
