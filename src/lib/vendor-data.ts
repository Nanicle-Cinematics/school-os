import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AGE_BUCKETS, billAgeFilterWhere, type AgeBucket } from "@/lib/bill-engine";

export async function getVendors(filters: { q?: string } = {}) {
  const vendors = await prisma.vendor.findMany({
    where: {
      isActive: true,
      ...(filters.q
        ? { name: { contains: filters.q, mode: Prisma.QueryMode.insensitive } }
        : {}),
    },
    orderBy: { name: "asc" },
    include: {
      bills: {
        // Approved bills only. A DRAFT is awaiting a second signature: the school
        // does not owe it yet, and payments cannot be made against it.
        where: { status: { in: ["APPROVED", "PARTIALLY_PAID", "PAID"] } },
        select: { balance: true },
      },
    },
  });

  return vendors.map((vendor) => ({
    id: vendor.id,
    name: vendor.name,
    contactPerson: vendor.contactPerson,
    phone: vendor.phone,
    owed: vendor.bills.reduce((sum, b) => sum + Number(b.balance), 0),
    billCount: vendor.bills.length,
  }));
}

export async function getActiveVendors() {
  return prisma.vendor.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });
}

export async function getBillCategories() {
  return prisma.expenseCategory.findMany({
    where: { isActive: true },
    orderBy: { order: "asc" },
    select: { id: true, name: true },
  });
}

/** How long bills have been owed, same 30/60/90 shape as `getDebtorAgeing`. */
export async function getCreditorAgeing() {
  const now = new Date();
  const rows: { bucket: AgeBucket; count: number; total: number }[] = [];
  for (const bucket of AGE_BUCKETS) {
    const result = await prisma.vendorBill.aggregate({
      where: billAgeFilterWhere(bucket, now),
      _sum: { balance: true },
      _count: true,
    });
    rows.push({ bucket, count: result._count, total: Number(result._sum.balance ?? 0) });
  }
  return rows;
}

export async function getVendorDetail(vendorId: string) {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    include: {
      bills: {
        where: { status: { not: "CANCELLED" } },
        orderBy: [{ dueDate: "asc" }, { billDate: "asc" }],
        include: { category: { select: { name: true } } },
      },
      payments: {
        orderBy: { paidAt: "desc" },
        include: { allocations: { include: { vendorBill: { select: { billNo: true } } } } },
      },
    },
  });
  return vendor;
}
