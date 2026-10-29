import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant-context";
import { decryptGatewaySecret } from "@/lib/gateway-crypto";
import { verifyTransaction, transactionMatches, type VerifyResult } from "@/lib/paystack";
import { bookPayment, sendReceiptSms } from "@/lib/payment-booking";
import { writeAudit } from "@/lib/audit";

/**
 * Turning a parent's Paystack payment into a receipt.
 *
 * Called from two places that must agree: Paystack's webhook (no session, the authoritative path)
 * and the page the parent lands on afterwards (a session, and the safety net for a school that
 * never pasted the webhook address into its Paystack dashboard). Both do the same thing, so it is
 * one function, and it TRUSTS NOTHING THE CALLER SAYS: not the amount, not the pupil, not that the
 * payment succeeded. The only input is a reference, and the outcome is whatever Paystack answers
 * when asked with the school's own secret key.
 *
 * ⚠️ Idempotent by construction, because Paystack retries a webhook until it hears 200 and the
 * parent can refresh the return page. Under an advisory lock on the reference, the booking and the
 * flip of the row to PAID share one transaction, and the flip is conditional on it not being PAID
 * already. A replay finds PAID and books nothing.
 */
export type SettleState = "booked" | "already" | "pending" | "failed" | "mismatch" | "unknown" | "error";

export type SettleResult = { state: SettleState; receiptNo?: string; detail?: string };

export type SettleDeps = {
  verify?: (secretKey: string, reference: string) => Promise<VerifyResult>;
};

export async function settleOnlinePayment(
  schoolId: string,
  reference: string,
  deps: SettleDeps = {},
): Promise<SettleResult> {
  // No session reaches here from a webhook, so the tenant is named explicitly. `readOnly` is left
  // unset ON PURPOSE: the money has already left the parent's phone, and a school whose
  // subscription lapsed must still have it recorded rather than lost.
  return runWithTenantContext({ schoolId }, () => settle(schoolId, reference, deps));
}

async function settle(schoolId: string, reference: string, deps: SettleDeps): Promise<SettleResult> {
  const attempt = await prisma.onlinePayment.findUnique({
    where: { schoolId_reference: { schoolId, reference } },
    select: { id: true, status: true, amount: true, studentId: true },
  });
  if (!attempt) {
    return { state: "unknown" };
  }
  if (attempt.status === "PAID") {
    return { state: "already" };
  }

  const gateway = await prisma.paymentGateway.findUnique({
    where: { schoolId },
    select: { secretKeyEnc: true },
  });
  if (!gateway?.secretKeyEnc) {
    return { state: "error", detail: "The school has no Paystack key saved." };
  }

  let secretKey: string;
  try {
    secretKey = decryptGatewaySecret(gateway.secretKeyEnc);
  } catch {
    return { state: "error", detail: "The saved Paystack key can no longer be read; the school must enter it again." };
  }

  const verified = await (deps.verify ?? verifyTransaction)(secretKey, reference);
  if (verified.state === "pending") return { state: "pending" };
  if (verified.state === "error") return { state: "error", detail: verified.reason };
  if (verified.state === "failed") {
    // Not terminal (Paystack lets a parent retry within one transaction), so a later success still books.
    await prisma.onlinePayment.updateMany({
      where: { id: attempt.id, status: "PENDING" },
      data: { status: "FAILED", problem: verified.reason },
    });
    return { state: "failed", detail: verified.reason };
  }

  const match = transactionMatches({ reference, amount: attempt.amount }, verified.transaction);
  if (!match.ok) {
    // Money moved but not as agreed. Never booked automatically; kept on the row for a person to see.
    await prisma.onlinePayment.updateMany({
      where: { id: attempt.id, status: { not: "PAID" } },
      data: { problem: match.reason },
    });
    return { state: "mismatch", detail: match.reason };
  }

  const { transaction } = verified;
  const method = transaction.channel === "mobile_money" ? "MOBILE_MONEY" : "CARD";

  let receiptNo: string | null = null;
  let amount = new Prisma.Decimal(attempt.amount);
  try {
    receiptNo = await tenantTransaction(schoolId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"online:" + reference}))`;

      // Re-read UNDER the lock: the check above was made before it, and a second delivery of the
      // same webhook may have booked in between.
      const fresh = await tx.onlinePayment.findUnique({
        where: { schoolId_reference: { schoolId, reference } },
        select: { id: true, status: true, amount: true },
      });
      if (!fresh || fresh.status === "PAID") {
        return null;
      }
      amount = new Prisma.Decimal(fresh.amount);

      const booked = await bookPayment(tx, {
        schoolId,
        studentId: attempt.studentId,
        amount,
        method,
        momoNetwork: transaction.network,
        reference,
        note: "Paid online through Paystack",
        paidAt: new Date(),
        actorUserId: null,
        providerRef: reference,
        providerStatus: "success",
        action: "payment.online",
      });

      await tx.onlinePayment.update({
        where: { id: fresh.id },
        data: {
          status: "PAID",
          paymentId: booked.paymentId,
          channel: transaction.channel,
          paidAt: new Date(),
          problem: null,
        },
      });
      return booked.receiptNo;
    });
  } catch (error) {
    // Paystack has the money and we could not record it: this must be findable in the logs.
    console.error(`online payment ${reference} could not be booked for school ${schoolId}`, error);
    const detail =
      error instanceof Error && error.message === "STUDENT_NOT_FOUND"
        ? "The pupil no longer exists."
        : "The payment could not be recorded.";
    await prisma.onlinePayment.updateMany({
      where: { id: attempt.id, status: { not: "PAID" } },
      data: { problem: detail },
    });
    // Paystack has the money and we do not have the receipt: say so loudly in the audit trail.
    await tenantTransaction(schoolId, (tx) =>
      writeAudit(tx, {
        schoolId,
        action: "payment.online.unbooked",
        entity: "OnlinePayment",
        entityId: attempt.id,
        after: { reference, detail },
      }),
    ).catch(() => undefined);
    return { state: "error", detail };
  }

  if (receiptNo === null) {
    return { state: "already" };
  }

  // After the commit, best effort. The receipt text must never be able to undo a payment.
  try {
    const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { name: true } });
    await sendReceiptSms({ schoolId, schoolName: school?.name ?? "", receiptNo, amount });
  } catch {
    /* the payment stands; the office can see the receipt on /payments */
  }

  return { state: "booked", receiptNo };
}
