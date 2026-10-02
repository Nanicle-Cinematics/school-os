import "server-only";

import { Prisma } from "@prisma/client";
import type { InvoiceStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PLAN_SELECT, keepingToPlan } from "@/lib/report-access";
import {
  AGE_BUCKETS,
  ageBucket,
  ageFilterWhere,
  statusFilterWhere,
  type AgeBucket,
} from "@/lib/invoice-engine";
import {
  chooseFeeStructure,
  explainNoStructure,
  priceFromStructure,
  type SkippedStudent,
} from "@/lib/invoice-engine";
import type { Proforma } from "@/app/(app)/invoices/proforma-bill";

type ProformaRow = Proforma;

export type InvoiceFilters = {
  termId?: string;
  classGroupId?: string;
  status?: InvoiceStatus | "DEBTORS";
  age?: AgeBucket;
  q?: string;
};

/** The invoice list's visible page; the debtors view needs every row, not the top 200. */
const LIST_PAGE = 200;

/** Later term = larger. Year start first, then the term's place in the year. */
function termOrder(term: { sequence: number; academicYear: { startDate: Date } }) {
  return term.academicYear.startDate.getTime() * 100 + term.sequence;
}

export async function getInvoiceList(
  filters: InvoiceFilters,
  opts: { take?: number | null } = {},
) {
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
      ...(opts.take === null ? {} : { take: opts.take ?? LIST_PAGE }),
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
        term: { select: { name: true, sequence: true, academicYear: { select: { startDate: true } } } },
      },
    }),
    prisma.invoice.aggregate({
      where,
      _sum: { total: true, amountPaid: true, balance: true },
      _count: true,
    }),
  ]);

  // ⚠️ Within ONE term, summing balances is the running figure. Across terms the
  // balances are a chain — each carries the one before — so adding them counts the
  // same arrears once per term. With no term chosen, take each pupil's LATEST
  // matching invoice instead, which already includes everything before it.
  let outstanding = totals._sum.balance ?? new Prisma.Decimal(0);
  if (!filters.termId) {
    const owing = await prisma.invoice.findMany({
      where: { ...where, balance: { gt: 0 } },
      select: {
        studentId: true,
        balance: true,
        term: { select: { sequence: true, academicYear: { select: { startDate: true } } } },
      },
    });
    const latest = new Map<string, { order: number; balance: Prisma.Decimal }>();
    for (const row of owing) {
      const order = termOrder(row.term);
      const seen = latest.get(row.studentId);
      if (!seen || order > seen.order) {
        latest.set(row.studentId, { order, balance: row.balance });
      }
    }
    outstanding = [...latest.values()].reduce((sum, row) => sum.add(row.balance), new Prisma.Decimal(0));
  }

  return {
    invoices,
    count: totals._count,
    billed: totals._sum.total ?? new Prisma.Decimal(0),
    collected: totals._sum.amountPaid ?? new Prisma.Decimal(0),
    outstanding,
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

export type DebtorRow = {
  studentId: string;
  firstName: string;
  lastName: string;
  admissionNo: string;
  className: string | null;
  totalOwed: number;
  invoiceCount: number;
  oldestBucket: AgeBucket;
  onKeptPlan: boolean;
};

/**
 * "Owing (debtors)" on /invoices is one row per INVOICE, which is right for
 * chasing a specific bill but wrong for a bursar's debtors list — a family
 * with two terms of arrears reads as two rows instead of one debt. This
 * groups the same underlying query (`getInvoiceList`, `invoicesOnKeptPlans`)
 * per STUDENT, so the two screens cannot disagree about who owes what.
 *
 * `oldestBucket` takes the worst bucket across a student's owed invoices —
 * AGE_BUCKETS is already ordered CURRENT → D90_PLUS, so an index comparison
 * is enough. `onKeptPlan` is true only when EVERY owed invoice for that
 * student is covered — a plan on one term does not excuse arrears on another.
 */
export async function getDebtorsByStudent(filters: {
  termId?: string;
  classGroupId?: string;
  age?: AgeBucket;
  q?: string;
}): Promise<{ debtors: DebtorRow[]; totalOwed: number }> {
  const [{ invoices }, plans] = await Promise.all([
    // No cap: this view adds the rows up, so a page of the top 200 understated the
    // total and left the smaller debtors off the list entirely.
    getInvoiceList({ ...filters, status: "DEBTORS" }, { take: null }),
    invoicesOnKeptPlans(filters.termId),
  ]);

  const now = new Date();
  const byStudent = new Map<string, DebtorRow>();
  const latestOrder = new Map<string, number>();

  for (const invoice of invoices) {
    const bucket = ageBucket(invoice, now);
    const onKept = plans.kept.has(invoice.id);
    const existing = byStudent.get(invoice.studentId);

    const order = termOrder(invoice.term);

    if (existing) {
      // The pupil owes what their LATEST invoice says; earlier ones are already
      // inside it (carried forward), so adding them would count arrears twice.
      if (order > latestOrder.get(invoice.studentId)!) {
        existing.totalOwed = Number(invoice.balance);
        latestOrder.set(invoice.studentId, order);
      }
      existing.invoiceCount += 1;
      existing.onKeptPlan = existing.onKeptPlan && onKept;
      if (AGE_BUCKETS.indexOf(bucket) > AGE_BUCKETS.indexOf(existing.oldestBucket)) {
        existing.oldestBucket = bucket;
      }
      continue;
    }

    latestOrder.set(invoice.studentId, order);
    byStudent.set(invoice.studentId, {
      studentId: invoice.studentId,
      firstName: invoice.student.firstName,
      lastName: invoice.student.lastName,
      admissionNo: invoice.student.admissionNo,
      className: invoice.student.currentClassGroup
        ? `${invoice.student.currentClassGroup.level.name} ${invoice.student.currentClassGroup.name}`
        : null,
      totalOwed: Number(invoice.balance),
      invoiceCount: 1,
      oldestBucket: bucket,
      onKeptPlan: onKept,
    });
  }

  const debtors = [...byStudent.values()].sort((a, b) => b.totalOwed - a.totalOwed);
  const totalOwed = debtors.reduce((sum, d) => sum + d.totalOwed, 0);
  return { debtors, totalOwed };
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
      tin: true,
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

/**
 * What a term WOULD cost each pupil, without invoicing anybody.
 *
 * Read-only on purpose: an advance bill is printed in the holidays, weeks
 * before the office is ready to raise real invoices, and generating them early
 * to produce a piece of paper would mean cancelling or editing them later. So
 * this prices the term and writes nothing.
 *
 * ⚠️ The reads mirror `generateInvoicesForTerm` deliberately — same structures,
 * same discounts, same brought-forward balance from the previous term — and the
 * arithmetic itself is `priceFromStructure`, which the generator now also uses.
 * A pro-forma that quotes a figure the invoice then contradicts is worse than
 * no pro-forma: the parent has the paper, and the office has the argument.
 */
export async function getProformaForTerm(
  termId: string,
  options: { classGroupId?: string } = {},
) {
  const term = await prisma.term.findUnique({
    where: { id: termId },
    include: { academicYear: true },
  });
  if (!term) {
    return null;
  }

  const students = await prisma.student.findMany({
    where: {
      status: "ACTIVE",
      deletedAt: null,
      ...(options.classGroupId ? { currentClassGroupId: options.classGroupId } : {}),
    },
    include: {
      currentClassGroup: { select: { name: true, levelId: true, level: { select: { name: true } } } },
      discounts: { where: { academicYearId: term.academicYearId }, include: { discount: true } },
      guardians: {
        where: { receivesBills: true },
        include: { guardian: true },
        orderBy: { isPrimary: "desc" },
        take: 1,
      },
    },
    orderBy: { admissionNo: "asc" },
  });

  const structures = await prisma.feeStructure.findMany({
    where: { academicYearId: term.academicYearId, isActive: true },
    include: { items: { include: { feeCategory: true } } },
  });

  const previousTerm = await prisma.term.findFirst({
    where: { academicYearId: term.academicYearId, sequence: term.sequence - 1 },
  });
  const previousBalances = new Map<string, Prisma.Decimal>(
    previousTerm
      ? (
          await prisma.invoice.findMany({
            where: { termId: previousTerm.id, status: { not: "CANCELLED" } },
            select: { studentId: true, balance: true },
          })
        ).map((row) => [row.studentId, row.balance])
      : [],
  );

  const priced: ProformaRow[] = [];
  const skipped: SkippedStudent[] = [];

  for (const student of students) {
    const who = {
      admissionNo: student.admissionNo,
      name: `${student.firstName} ${student.lastName}`,
    };
    const levelId = student.currentClassGroup?.levelId;
    if (!levelId) {
      skipped.push({ ...who, reason: { kind: "NO_CLASS" } });
      continue;
    }

    const profile = {
      residency: student.residency,
      isNew: student.admissionDate ? student.admissionDate >= term.academicYear.startDate : false,
    };
    const levelStructures = structures.filter((s) => s.levelId === levelId);
    const structure = chooseFeeStructure(levelStructures, profile, termId);
    if (!structure) {
      const level = student.currentClassGroup?.level?.name ?? "their level";
      skipped.push({
        ...who,
        reason: explainNoStructure(levelStructures, profile, termId, level),
      });
      continue;
    }

    const money = priceFromStructure(
      student.schoolId,
      structure,
      student.discounts.map((sd) => sd.discount),
      previousBalances.get(student.id) ?? new Prisma.Decimal(0),
    );
    const link = student.guardians[0]?.guardian ?? null;

    priced.push({
      student: {
        firstName: student.firstName,
        lastName: student.lastName,
        admissionNo: student.admissionNo,
        className: student.currentClassGroup
          ? `${student.currentClassGroup.level.name} ${student.currentClassGroup.name}`
          : null,
      },
      guardian: link ? { firstName: link.firstName, lastName: link.lastName, phone: link.phone } : null,
      lines: money.lines.map((l) => ({
        description: l.description,
        amount: l.amount,
        discount: l.discount,
      })),
      subtotal: money.subtotal,
      discountTotal: money.discountTotal,
      broughtForward: money.broughtForward,
      total: money.total,
    });
  }

  return { term, priced, skipped };
}
