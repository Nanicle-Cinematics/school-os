import "server-only";

import { Prisma } from "@prisma/client";
import type { VendorBill } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";

type Tx = TenantTx;

/**
 * What a vendor bill's status means, once payments exist.
 *
 * Only an APPROVED bill can be paid — recordVendorPayment refuses a DRAFT
 * one — so recalcVendorBill only ever runs on a bill that was already
 * APPROVED, and "nothing paid yet" must return to APPROVED, not DRAFT. Same
 * lesson as `invoiceStatusFor`: the stored status records an EVENT
 * (approved, part-paid, paid), and a CANCELLED bill is never revived by a
 * recalc.
 */
export function vendorBillStatusFor(amount: Prisma.Decimal, paid: Prisma.Decimal) {
  if (paid.greaterThanOrEqualTo(amount) && amount.greaterThan(0)) {
    return "PAID" as const;
  }
  if (paid.greaterThan(0)) {
    return "PARTIALLY_PAID" as const;
  }
  return "APPROVED" as const;
}

/** Recompute a vendor bill's amountPaid/balance/status from its allocations. */
export async function recalcVendorBill(tx: Tx, vendorBillId: string) {
  const bill = await tx.vendorBill.findUniqueOrThrow({
    where: { id: vendorBillId },
    include: { allocations: true },
  });

  const amountPaid = bill.allocations.reduce(
    (acc, allocation) => acc.add(allocation.amount),
    new Prisma.Decimal(0),
  );
  const balance = bill.amount.sub(amountPaid);

  return tx.vendorBill.update({
    where: { id: vendorBillId },
    data: {
      amountPaid,
      balance,
      status: bill.status === "CANCELLED" ? "CANCELLED" : vendorBillStatusFor(bill.amount, amountPaid),
    },
  });
}

/** Spread a payment across a vendor's unpaid bills, oldest due date first. Mirrors `allocateFifo` in invoice-engine.ts. */
export function allocateFifoBills(
  bills: Pick<VendorBill, "id" | "balance">[],
  amount: Prisma.Decimal,
): { vendorBillId: string; amount: Prisma.Decimal }[] {
  const allocations: { vendorBillId: string; amount: Prisma.Decimal }[] = [];
  let remaining = new Prisma.Decimal(amount);

  for (const bill of bills) {
    if (remaining.lessThanOrEqualTo(0)) {
      break;
    }
    if (bill.balance.lessThanOrEqualTo(0)) {
      continue;
    }
    const applied = remaining.greaterThan(bill.balance) ? bill.balance : remaining;
    allocations.push({ vendorBillId: bill.id, amount: applied });
    remaining = remaining.sub(applied);
  }

  return allocations;
}

/**
 * How long a bill has been owed, in the same 30/60/90 buckets as debtor
 * ageing — an accountant reads both the same way.
 */
export const AGE_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D61_90", "D90_PLUS"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const AGE_LABEL: Record<AgeBucket, string> = {
  CURRENT: "Not yet due",
  D1_30: "1–30 days",
  D31_60: "31–60 days",
  D61_90: "61–90 days",
  D90_PLUS: "Over 90 days",
};

type Dateable = { balance: Prisma.Decimal | number | string; dueDate: Date | null; status: string };

function daysOverdue(bill: Dateable, now: Date): number | null {
  if (bill.status === "CANCELLED" || !bill.dueDate || bill.dueDate >= now || Number(bill.balance) <= 0) {
    return null;
  }
  return Math.floor((now.getTime() - bill.dueDate.getTime()) / 86_400_000);
}

export function billAgeBucket(bill: Dateable, now = new Date()): AgeBucket {
  const days = daysOverdue(bill, now);
  if (days === null) return "CURRENT";
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

export function billAgeFilterWhere(bucket: AgeBucket | undefined, now = new Date()) {
  if (!bucket) return {};
  const owed = { balance: { gt: 0 }, status: { not: "CANCELLED" as const } };
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  switch (bucket) {
    case "CURRENT":
      return { ...owed, OR: [{ dueDate: null }, { dueDate: { gte: now } }] };
    case "D1_30":
      return { ...owed, dueDate: { lt: now, gte: daysAgo(30) } };
    case "D31_60":
      return { ...owed, dueDate: { lt: daysAgo(30), gte: daysAgo(60) } };
    case "D61_90":
      return { ...owed, dueDate: { lt: daysAgo(60), gte: daysAgo(90) } };
    case "D90_PLUS":
      return { ...owed, dueDate: { lt: daysAgo(90) } };
  }
}
