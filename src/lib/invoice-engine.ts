import "server-only";

import { Prisma } from "@prisma/client";
import type { Invoice, Student } from "@prisma/client";
import { money } from "@/lib/money";
import type { TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";

type Tx = TenantTx;

/**
 * Pick the fee structure that applies to a student for a term.
 *
 * Specificity wins: a structure naming this student's exact residency or
 * student-type beats a catch-all ANY, and a term-specific structure beats a
 * whole-year one. That lets a school price "SHS 1 boarding, new student, term 1"
 * without writing a structure for every combination.
 */
export function chooseFeeStructure<
  T extends {
    termId: string | null;
    residency: "ANY" | "DAY" | "BOARDING";
    studentType: "ANY" | "NEW" | "CONTINUING";
  },
>(structures: T[], student: { residency: "DAY" | "BOARDING"; isNew: boolean }, termId: string) {
  const applicable = structures.filter(
    (s) =>
      (s.termId === null || s.termId === termId) &&
      (s.residency === "ANY" || s.residency === student.residency) &&
      (s.studentType === "ANY" ||
        (s.studentType === "NEW" ? student.isNew : !student.isNew)),
  );

  if (applicable.length === 0) {
    return null;
  }

  const score = (s: T) =>
    (s.termId === termId ? 4 : 0) +
    (s.residency !== "ANY" ? 2 : 0) +
    (s.studentType !== "ANY" ? 1 : 0);

  return applicable.reduce((best, current) => (score(current) > score(best) ? current : best));
}

/**
 * Apply a student's discounts to one fee line.
 * A discount restricted to a category only touches that category; percentage
 * discounts are computed on the line, fixed discounts are capped at the line.
 */
export function discountForLine(
  discounts: { type: "PERCENTAGE" | "FIXED"; value: Prisma.Decimal; appliesToCategoryId: string | null }[],
  categoryId: string,
  amount: Prisma.Decimal,
): Prisma.Decimal {
  let total = new Prisma.Decimal(0);

  for (const discount of discounts) {
    if (discount.appliesToCategoryId && discount.appliesToCategoryId !== categoryId) {
      continue;
    }
    const value =
      discount.type === "PERCENTAGE"
        ? amount.mul(discount.value).div(100)
        : new Prisma.Decimal(discount.value);
    total = total.add(value);
  }

  // Never discount a line below zero.
  return total.greaterThan(amount) ? amount : total;
}

export function invoiceStatusFor(total: Prisma.Decimal, paid: Prisma.Decimal, dueDate: Date | null) {
  if (paid.greaterThanOrEqualTo(total) && total.greaterThan(0)) {
    return "PAID" as const;
  }
  if (paid.greaterThan(0)) {
    return "PARTIALLY_PAID" as const;
  }
  if (dueDate && dueDate < new Date()) {
    return "OVERDUE" as const;
  }
  return "ISSUED" as const;
}

/**
 * Recompute an invoice's totals from its items and allocations, then persist.
 * Called after anything that can change the arithmetic — a payment, a reversal,
 * an edited line — so `balance` and `status` are never derived in the UI.
 */
export async function recalcInvoice(tx: Tx, invoiceId: string) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: true, allocations: true },
  });

  const subtotal = invoice.items.reduce(
    (acc, item) => acc.add(item.amount),
    new Prisma.Decimal(0),
  );
  const discountTotal = invoice.items.reduce(
    (acc, item) => acc.add(item.discount),
    new Prisma.Decimal(0),
  );
  const total = subtotal.sub(discountTotal).add(invoice.broughtForward);
  const amountPaid = invoice.allocations.reduce(
    (acc, allocation) => acc.add(allocation.amount),
    new Prisma.Decimal(0),
  );
  const balance = total.sub(amountPaid);

  return tx.invoice.update({
    where: { id: invoiceId },
    data: {
      subtotal,
      discountTotal,
      total,
      amountPaid,
      balance,
      status:
        invoice.status === "CANCELLED"
          ? "CANCELLED"
          : invoiceStatusFor(total, amountPaid, invoice.dueDate),
    },
  });
}

export type GenerationResult = {
  created: number;
  skipped: number;
  noStructure: { admissionNo: string; name: string }[];
};

/**
 * Build term invoices for every active student who doesn't already have one.
 *
 * Idempotent by design — Invoice is unique on (studentId, termId), and we skip
 * rather than error, so a bursar can safely re-run it after admitting a few
 * more students mid-term.
 */
export async function generateInvoicesForTerm(
  tx: Tx,
  schoolId: string,
  termId: string,
  dueDays: number,
): Promise<GenerationResult> {
  const term = await tx.term.findUniqueOrThrow({
    where: { id: termId },
    include: { academicYear: true },
  });

  const students = await tx.student.findMany({
    where: { schoolId, status: "ACTIVE", deletedAt: null },
    include: {
      currentClassGroup: { select: { levelId: true } },
      invoices: { where: { termId }, select: { id: true } },
      discounts: {
        where: { academicYearId: term.academicYearId },
        include: { discount: true },
      },
    },
    orderBy: { admissionNo: "asc" },
  });

  const structures = await tx.feeStructure.findMany({
    where: { schoolId, academicYearId: term.academicYearId, isActive: true },
    include: { items: { include: { feeCategory: true } } },
  });

  // Previous term's unpaid balance rolls into this invoice as broughtForward.
  const previousTerm = await tx.term.findFirst({
    where: { schoolId, academicYearId: term.academicYearId, sequence: term.sequence - 1 },
  });
  const previousBalances = previousTerm
    ? new Map(
        (
          await tx.invoice.findMany({
            where: { schoolId, termId: previousTerm.id, status: { not: "CANCELLED" } },
            select: { studentId: true, balance: true },
          })
        ).map((row) => [row.studentId, row.balance]),
      )
    : new Map<string, Prisma.Decimal>();

  const dueDate = new Date(term.startDate);
  dueDate.setDate(dueDate.getDate() + dueDays);

  const result: GenerationResult = { created: 0, skipped: 0, noStructure: [] };

  for (const student of students) {
    if (student.invoices.length > 0) {
      result.skipped += 1;
      continue;
    }

    const levelId = student.currentClassGroup?.levelId;
    if (!levelId) {
      result.noStructure.push({
        admissionNo: student.admissionNo,
        name: `${student.firstName} ${student.lastName}`,
      });
      continue;
    }

    const structure = chooseFeeStructure(
      structures.filter((s) => s.levelId === levelId),
      {
        residency: student.residency,
        isNew: student.admissionDate ? student.admissionDate >= term.academicYear.startDate : false,
      },
      termId,
    );

    if (!structure) {
      result.noStructure.push({
        admissionNo: student.admissionNo,
        name: `${student.firstName} ${student.lastName}`,
      });
      continue;
    }

    const discounts = student.discounts.map((sd) => sd.discount);
    const lines = structure.items.map((item) => ({
      schoolId,
      feeCategoryId: item.feeCategoryId,
      description: item.feeCategory.name,
      amount: item.amount,
      discount: discountForLine(discounts, item.feeCategoryId, item.amount),
    }));

    const subtotal = lines.reduce((acc, l) => acc.add(l.amount), new Prisma.Decimal(0));
    const discountTotal = lines.reduce((acc, l) => acc.add(l.discount), new Prisma.Decimal(0));
    const broughtForward = previousBalances.get(student.id) ?? new Prisma.Decimal(0);
    const total = subtotal.sub(discountTotal).add(broughtForward);

    const invoiceNo = await nextNumber(tx, schoolId, "INVOICE", takenProbes.invoice(tx, schoolId));

    await tx.invoice.create({
      data: {
        schoolId,
        studentId: student.id,
        termId,
        invoiceNo,
        issueDate: new Date(),
        dueDate,
        subtotal,
        discountTotal,
        broughtForward,
        total,
        amountPaid: money(0),
        balance: total,
        status: "ISSUED",
        items: { create: lines },
      },
    });

    result.created += 1;
  }

  return result;
}

/**
 * Spread a payment across a student's unpaid invoices, oldest first.
 * Parents pay a lump sum against "school fees", not against invoice numbers, so
 * FIFO across arrears then current term is the behaviour bursars expect.
 */
export function allocateFifo(
  invoices: Pick<Invoice, "id" | "balance">[],
  amount: Prisma.Decimal,
): { invoiceId: string; amount: Prisma.Decimal }[] {
  const allocations: { invoiceId: string; amount: Prisma.Decimal }[] = [];
  let remaining = new Prisma.Decimal(amount);

  for (const invoice of invoices) {
    if (remaining.lessThanOrEqualTo(0)) {
      break;
    }
    if (invoice.balance.lessThanOrEqualTo(0)) {
      continue;
    }
    const applied = remaining.greaterThan(invoice.balance) ? invoice.balance : remaining;
    allocations.push({ invoiceId: invoice.id, amount: applied });
    remaining = remaining.sub(applied);
  }

  return allocations;
}

export type StudentSummary = Pick<Student, "id" | "firstName" | "lastName" | "admissionNo">;
