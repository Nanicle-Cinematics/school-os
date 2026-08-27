import "server-only";

import { Prisma } from "@prisma/client";
import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

export type InvoiceFilters = {
  termId?: string;
  classGroupId?: string;
  status?: InvoiceStatus | "DEBTORS";
  q?: string;
};

export async function getInvoiceList(filters: InvoiceFilters) {
  const where: Prisma.InvoiceWhereInput = {
    ...(filters.termId ? { termId: filters.termId } : {}),
    ...(filters.status === "DEBTORS"
      ? { balance: { gt: 0 }, status: { not: "CANCELLED" } }
      : filters.status
        ? { status: filters.status }
        : {}),
    ...(filters.classGroupId ? { student: { currentClassGroupId: filters.classGroupId } } : {}),
    ...(filters.q
      ? {
          OR: [
            { invoiceNo: { contains: filters.q, mode: "insensitive" } },
            { student: { firstName: { contains: filters.q, mode: "insensitive" } } },
            { student: { lastName: { contains: filters.q, mode: "insensitive" } } },
            { student: { admissionNo: { contains: filters.q, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [invoices, totals] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: [{ balance: "desc" }, { invoiceNo: "asc" }],
      take: 200,
      include: {
        student: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            admissionNo: true,
            currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
          },
        },
        term: { select: { name: true, sequence: true } },
      },
    }),
    prisma.invoice.aggregate({
      where,
      _sum: { total: true, amountPaid: true, balance: true },
      _count: true,
    }),
  ]);

  return {
    invoices,
    count: totals._count,
    billed: totals._sum.total ?? new Prisma.Decimal(0),
    collected: totals._sum.amountPaid ?? new Prisma.Decimal(0),
    outstanding: totals._sum.balance ?? new Prisma.Decimal(0),
  };
}

/**
 * Everything a printed bill shows. Named and shared so the single invoice and
 * the class print run cannot drift apart — the same reason report cards have
 * REPORT_CARD_INCLUDE.
 */
export const BILL_INCLUDE = {
  items: { include: { feeCategory: true } },
  term: { include: { academicYear: true } },
  student: {
    include: {
      currentClassGroup: { include: { level: true } },
      guardians: {
        where: { receivesBills: true },
        include: { guardian: true },
      },
    },
  },
} satisfies Prisma.InvoiceInclude;

export type BillInvoice = Prisma.InvoiceGetPayload<{ include: typeof BILL_INCLUDE }>;

export async function getInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: {
      ...BILL_INCLUDE,
      allocations: {
        include: { payment: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
}

/** One bill, for the single-invoice print. */
export async function getBill(id: string) {
  return prisma.invoice.findUnique({ where: { id }, include: BILL_INCLUDE });
}

/** The letterhead: whatever the school has filled in, plus how to pay. */
export async function getBillSchool(schoolId: string) {
  return prisma.school.findUnique({
    where: { id: schoolId },
    select: {
      name: true,
      motto: true,
      address: true,
      town: true,
      district: true,
      region: true,
      gpsAddress: true,
      phone: true,
      altPhone: true,
      email: true,
      website: true,
      headName: true,
      settings: { select: { paymentInstructions: true, invoiceNote: true } },
    },
  });
}

export type BillSchool = NonNullable<Awaited<ReturnType<typeof getBillSchool>>>;

/**
 * The bills to print for a term, optionally one class.
 *
 * Cancelled invoices are left out: they are not bills any more, and handing one
 * to a parent asks for money that is not owed. Settled ones are included by
 * default — a receipt-shaped "paid in full" is worth having — but `unpaidOnly`
 * skips them, which is what a bursar chasing arrears actually wants.
 */
export async function getBillsForTerm(
  termId: string,
  options: { classGroupId?: string; unpaidOnly?: boolean } = {},
) {
  return prisma.invoice.findMany({
    where: {
      termId,
      status: { not: "CANCELLED" },
      ...(options.unpaidOnly ? { balance: { gt: 0 } } : {}),
      ...(options.classGroupId
        ? { student: { currentClassGroupId: options.classGroupId } }
        : {}),
    },
    include: BILL_INCLUDE,
    orderBy: [
      { student: { currentClassGroup: { level: { order: "asc" } } } },
      { student: { currentClassGroup: { name: "asc" } } },
      { student: { lastName: "asc" } },
      { student: { firstName: "asc" } },
    ],
  });
}

export async function getInvoiceFilterOptions() {
  const [terms, classGroups] = await Promise.all([
    prisma.term.findMany({
      orderBy: [{ academicYear: { name: "desc" } }, { sequence: "asc" }],
      include: { academicYear: { select: { name: true } } },
      take: 12,
    }),
    prisma.classGroup.findMany({
      orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
      include: { level: { select: { name: true } } },
    }),
  ]);
  return { terms, classGroups };
}
