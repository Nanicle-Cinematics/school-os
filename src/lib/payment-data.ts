import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export async function getPaymentList(filters: { q?: string; method?: string }) {
  const where: Prisma.PaymentWhereInput = {
    ...(filters.method ? { method: filters.method as Prisma.EnumPaymentMethodFilter["equals"] } : {}),
    ...(filters.q
      ? {
          OR: [
            { receiptNo: { contains: filters.q, mode: "insensitive" } },
            { reference: { contains: filters.q, mode: "insensitive" } },
            { student: { firstName: { contains: filters.q, mode: "insensitive" } } },
            { student: { lastName: { contains: filters.q, mode: "insensitive" } } },
            { student: { admissionNo: { contains: filters.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [payments, totals] = await Promise.all([
    prisma.payment.findMany({
      where,
      orderBy: { paidAt: "desc" },
      take: 200,
      include: {
        student: {
          select: {
            firstName: true,
            lastName: true,
            admissionNo: true,
            currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
          },
        },
        recordedBy: { select: { name: true } },
        allocations: { include: { invoice: { select: { invoiceNo: true } } } },
      },
    }),
    prisma.payment.aggregate({
      where: { ...where, status: "CONFIRMED" },
      _sum: { amount: true },
      _count: true,
    }),
  ]);

  return {
    payments,
    total: totals._sum.amount ?? new Prisma.Decimal(0),
    count: totals._count,
  };
}

/** Students with an outstanding balance, for the record-payment picker. */
export async function getStudentsForPayment(query: string) {
  if (query.trim().length < 2) {
    return [];
  }
  return prisma.student.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      OR: [
        { firstName: { contains: query, mode: "insensitive" } },
        { lastName: { contains: query, mode: "insensitive" } },
        { admissionNo: { contains: query, mode: "insensitive" } },
      ],
    },
    orderBy: { lastName: "asc" },
    take: 20,
    select: {
      id: true,
      firstName: true,
      lastName: true,
      admissionNo: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
      invoices: {
        where: { balance: { gt: 0 }, status: { not: "CANCELLED" } },
        select: { balance: true },
      },
    },
  });
}

export async function getStudentAccount(studentId: string) {
  return prisma.student.findUnique({
    where: { id: studentId },
    include: {
      currentClassGroup: { include: { level: true } },
      guardians: { where: { isPrimary: true }, include: { guardian: true } },
      invoices: {
        where: { status: { not: "CANCELLED" } },
        orderBy: { issueDate: "asc" },
        include: { term: { select: { name: true, sequence: true } } },
      },
      payments: { orderBy: { paidAt: "desc" }, take: 20 },
    },
  });
}

export const RECEIPT_INCLUDE = {
  student: {
    select: {
      firstName: true,
      lastName: true,
      admissionNo: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
      guardians: {
        where: { receivesBills: true },
        include: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
      },
    },
  },
  guardian: { select: { firstName: true, lastName: true, phone: true } },
  recordedBy: { select: { name: true } },
  allocations: {
    include: {
      invoice: {
        select: {
          invoiceNo: true,
          balance: true,
          term: { select: { name: true, academicYear: { select: { name: true } } } },
        },
      },
    },
  },
} satisfies Prisma.PaymentInclude;

export type ReceiptPayment = Prisma.PaymentGetPayload<{ include: typeof RECEIPT_INCLUDE }>;

/**
 * One payment, with everything a receipt has to show.
 *
 * The outstanding figure is read back from the invoices this payment touched
 * rather than recomputed, because `recalcInvoice` has already settled them —
 * and a receipt quoting a balance the ledger disagrees with is worse than one
 * quoting none.
 */
export async function getReceipt(id: string) {
  return prisma.payment.findUnique({ where: { id }, include: RECEIPT_INCLUDE });
}

/**
 * Every payment of a term, for the office that prints a day's or a term's
 * receipts in one run rather than one at a time.
 *
 * Reversed payments are excluded: that money was given back, and a receipt for
 * it is a claim the school would have to honour twice.
 */
export async function getReceiptsForTerm(termId: string, opts: { day?: Date } = {}) {
  const day = opts.day;
  return prisma.payment.findMany({
    where: {
      status: { not: "REVERSED" },
      allocations: { some: { invoice: { termId } } },
      ...(day
        ? {
            paidAt: {
              gte: new Date(day.getFullYear(), day.getMonth(), day.getDate()),
              lt: new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1),
            },
          }
        : {}),
    },
    include: RECEIPT_INCLUDE,
    orderBy: { paidAt: "asc" },
  });
}
