import "server-only";

import { Prisma } from "@prisma/client";
import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLAN_SELECT, keepingToPlan } from "@/lib/report-access";
import { AGE_BUCKETS, ageFilterWhere, statusFilterWhere, type AgeBucket } from "@/lib/invoice-engine";

export type InvoiceFilters = {
  termId?: string;
  classGroupId?: string;
  status?: InvoiceStatus | "DEBTORS";
  age?: AgeBucket;
  q?: string;
};

export async function getInvoiceList(filters: InvoiceFilters) {
  const where: Prisma.InvoiceWhereInput = {
    ...(filters.termId ? { termId: filters.termId } : {}),
    // Built by statusFilterWhere, which lives in invoice-engine so it can be
    // tested without a database. OVERDUE is a QUESTION about dates and balance,
    // never a stored value to look up — see isOverdue().
    ...statusFilterWhere(filters.status),
    // Ageing narrows the same list rather than replacing it, so "debtors in
    // Class 5 owing over 90 days" is one query and not a special case.
    ...ageFilterWhere(filters.age),
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
/**
 * The ageing summary — how much is owed, and for how long.
 *
 * One grouped query per bucket rather than reading every debtor into memory and
 * bucketing in JS: a school with 900 pupils has 900 invoices a term, and the
 * office opens this screen constantly. The buckets come from ageFilterWhere, so
 * the totals here and the list a bursar clicks through to cannot disagree.
 *
 * Sequential, not Promise.all — connection_limit pins this low enough that a
 * five-way fan-out queues rather than parallelises, and the tail times out.
 */
/**
 * Bills whose families have an arrangement they are keeping to.
 *
 * ⚠️ Returned as a SET to subtract, rather than folded into the ageing query.
 * Whether a family is on track is a comparison between a schedule and a running
 * total, which SQL here cannot express — and pretending otherwise by filtering
 * on "has a plan" would excuse every family that agreed one and then stopped
 * paying, which is the opposite of what a school needs.
 *
 * So the ageing counts everyone, this names who is covered, and the screen
 * reports both. A plan is not a way to disappear from the report.
 */
export async function invoicesOnKeptPlans(termId?: string) {
  const withPlans = await prisma.invoice.findMany({
    where: {
      ...(termId ? { termId } : {}),
      balance: { gt: 0 },
      status: { not: "CANCELLED" },
      paymentPlan: { is: { cancelledAt: null } },
    },
    select: { id: true, amountPaid: true, balance: true, ...PLAN_SELECT },
  });

  const kept = new Set<string>();
  let covered = 0;
  for (const invoice of withPlans) {
    if (keepingToPlan(invoice)) {
      kept.add(invoice.id);
      covered += Number(invoice.balance);
    }
  }
  return { kept, covered, total: withPlans.length };
}

export async function getDebtorAgeing(termId?: string) {
  const now = new Date();
  const rows: { bucket: AgeBucket; count: number; total: number }[] = [];
  for (const bucket of AGE_BUCKETS) {
    const result = await prisma.invoice.aggregate({
      where: { ...(termId ? { termId } : {}), ...ageFilterWhere(bucket, now) },
      _sum: { balance: true },
      _count: true,
    });
    rows.push({
      bucket,
      count: result._count,
      total: Number(result._sum.balance ?? 0),
    });
  }
  return rows;
}

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
      paymentPlan: { include: { instalments: { orderBy: { sequence: "asc" } } } },
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
      crestUrl: true,
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
