import "server-only";

import type { TenantTx } from "@/lib/prisma";

export type SequenceKey =
  | "ADMISSION"
  | "STAFF"
  | "INVOICE"
  | "RECEIPT"
  | "VOUCHER"
  | "BILL"
  | "BILLPMT";

const DEFAULTS: Record<SequenceKey, { prefix: string; padding: number }> = {
  ADMISSION: { prefix: "ADM/", padding: 4 },
  STAFF: { prefix: "STF-", padding: 3 },
  INVOICE: { prefix: "INV-", padding: 5 },
  RECEIPT: { prefix: "RCT-", padding: 5 },
  VOUCHER: { prefix: "PV-", padding: 5 },
  BILL: { prefix: "BILL-", padding: 5 },
  BILLPMT: { prefix: "BPV-", padding: 5 },
};

type Tx = TenantTx;

const MAX_PROBES = 200;

/**
 * Allocate the next number in a per-school sequence.
 *
 * MUST be called inside a transaction (tenantTransaction) — the increment and
 * the row that uses the number have to commit together, or a rolled-back
 * invoice silently burns a number and the bursar's receipt book has a gap they
 * cannot explain to an auditor.
 *
 * `isTaken` guards against a counter that has fallen behind the data it names.
 * That is not hypothetical: a school migrating from paper or Excel will import
 * receipts numbered 1..N while the counter still sits at 1, and every write
 * would then fail on the unique constraint. Callers pass a probe and we walk
 * forward until we find a free number, self-healing the counter as we go.
 */
export async function nextNumber(
  tx: Tx,
  schoolId: string,
  key: SequenceKey,
  isTaken?: (candidate: string) => Promise<boolean>,
): Promise<string> {
  const fallback = DEFAULTS[key];

  for (let probe = 0; probe < MAX_PROBES; probe += 1) {
    const sequence = await tx.numberSequence.upsert({
      where: { schoolId_key: { schoolId, key } },
      create: { schoolId, key, prefix: fallback.prefix, padding: fallback.padding, next: 2 },
      update: { next: { increment: 1 } },
    });

    // upsert returns the row AFTER the increment, so the number we just claimed
    // is one below it. On create we seeded next=2 and claim 1.
    const claimed = sequence.next - 1;
    const candidate = `${sequence.prefix}${String(claimed).padStart(sequence.padding, "0")}`;

    if (!isTaken || !(await isTaken(candidate))) {
      return candidate;
    }
  }

  throw new Error(
    `Could not allocate a free ${key} number after ${MAX_PROBES} attempts — check the ${key} sequence against existing records.`,
  );
}

/** Probes for the three sequences that name a row with a unique constraint. */
export const takenProbes = {
  invoice: (tx: Tx, schoolId: string) => async (invoiceNo: string) =>
    (await tx.invoice.count({ where: { schoolId, invoiceNo } })) > 0,
  receipt: (tx: Tx, schoolId: string) => async (receiptNo: string) =>
    (await tx.payment.count({ where: { schoolId, receiptNo } })) > 0,
  voucher: (tx: Tx, schoolId: string) => async (voucherNo: string) =>
    (await tx.expense.count({ where: { schoolId, voucherNo } })) > 0,
  admission: (tx: Tx, schoolId: string) => async (admissionNo: string) =>
    (await tx.student.count({ where: { schoolId, admissionNo } })) > 0,
  bill: (tx: Tx, schoolId: string) => async (billNo: string) =>
    (await tx.vendorBill.count({ where: { schoolId, billNo } })) > 0,
  billPayment: (tx: Tx, schoolId: string) => async (paymentNo: string) =>
    (await tx.vendorPayment.count({ where: { schoolId, paymentNo } })) > 0,
};
