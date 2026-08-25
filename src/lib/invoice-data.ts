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

export async function getInvoice(id: string) {
  return prisma.invoice.findUnique({
    where: { id },
    include: {
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
      allocations: {
        include: { payment: true },
        orderBy: { createdAt: "asc" },
      },
    },
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
