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

/**
 * Why a student could not be billed. Four different problems used to arrive as
 * one sentence ("no class or no fee structure for their level"), which named
 * neither the students' actual situation nor the screen that fixes it — the
 * bursar is left to guess which of four things is wrong.
 */
export type SkipReason =
  | { kind: "NO_CLASS" }
  | { kind: "NO_STRUCTURE_FOR_LEVEL"; level: string }
  | { kind: "WRONG_TERM"; level: string }
  | { kind: "WRONG_RESIDENCY"; level: string; residency: "DAY" | "BOARDING" }
  | { kind: "WRONG_STUDENT_TYPE"; level: string; isNew: boolean };

export type SkippedStudent = {
  admissionNo: string;
  name: string;
  reason: SkipReason;
};

export type GenerationResult = {
  created: number;
  skipped: number;
  noStructure: SkippedStudent[];
};

/**
 * Narrow a failed match to the one filter that excluded every candidate.
 * Ordered from the coarsest to the most specific, so the answer names the
 * broadest thing that is wrong rather than an incidental detail of one row.
 */
export function explainNoStructure(
  levelStructures: {
    termId: string | null;
    residency: "ANY" | "DAY" | "BOARDING";
    studentType: "ANY" | "NEW" | "CONTINUING";
  }[],
  student: { residency: "DAY" | "BOARDING"; isNew: boolean },
  termId: string,
  level: string,
): SkipReason {
  if (levelStructures.length === 0) {
    return { kind: "NO_STRUCTURE_FOR_LEVEL", level };
  }

  const thisTerm = levelStructures.filter((s) => s.termId === null || s.termId === termId);
  if (thisTerm.length === 0) {
    return { kind: "WRONG_TERM", level };
  }

  const forResidency = thisTerm.filter(
    (s) => s.residency === "ANY" || s.residency === student.residency,
  );
  if (forResidency.length === 0) {
    return { kind: "WRONG_RESIDENCY", level, residency: student.residency };
  }

  return { kind: "WRONG_STUDENT_TYPE", level, isNew: student.isNew };
}

export type BlockedGroup = {
  /** What is wrong, in the bursar's words. */
  problem: string;
  /** What to do about it, naming the screen. */
  fix: string;
  students: { admissionNo: string; name: string }[];
};

const reasonKey = (reason: SkipReason) =>
  reason.kind === "NO_CLASS" ? "NO_CLASS" : `${reason.kind}:${reason.level}`;

function describe(reason: SkipReason, count: number): { problem: string; fix: string } {
  const they = count === 1 ? "This student is" : "These students are";
  const their = count === 1 ? "their" : "their";

  switch (reason.kind) {
    case "NO_CLASS":
      return {
        problem: `${they} not in a class yet, so there is no level to price ${their} fees from.`,
        fix: "Place them on the Students screen — open the student and set their class.",
      };
    case "NO_STRUCTURE_FOR_LEVEL":
      return {
        problem: `${reason.level} has no fee structure for this year.`,
        fix: `Price ${reason.level} on Finance → Fee structure.`,
      };
    case "WRONG_TERM":
      return {
        problem: `${reason.level} is priced, but only for a different term.`,
        fix: `Add a structure for this term on Finance → Fee structure, or set the existing one's term to "All terms".`,
      };
    case "WRONG_RESIDENCY":
      return {
        problem: `${reason.level} is priced, but not for ${
          reason.residency === "DAY" ? "day students" : "boarders"
        }.`,
        fix: `Add a structure for ${
          reason.residency === "DAY" ? "day students" : "boarders"
        }, or set an existing one's "Applies to" to day and boarding.`,
      };
    case "WRONG_STUDENT_TYPE":
      return {
        problem: `${reason.level} is priced, but not for ${
          reason.isNew ? "new" : "continuing"
        } students.`,
        fix: `Add a structure for ${
          reason.isNew ? "new" : "continuing"
        } students, or set an existing one's "Student type" to new and continuing.`,
      };
  }
}

/**
 * Collapse the skipped list into one group per distinct problem.
 *
 * Grouping rather than listing matters at scale: a school that forgot to price
 * JHS 2 skips forty children, and forty names in a banner say far less than
 * "JHS 2 has no fee structure" said once.
 */
export function groupSkipped(skipped: SkippedStudent[]): BlockedGroup[] {
  const groups = new Map<string, { reason: SkipReason; students: SkippedStudent[] }>();

  for (const student of skipped) {
    const key = reasonKey(student.reason);
    const existing = groups.get(key);
    if (existing) {
      existing.students.push(student);
    } else {
      groups.set(key, { reason: student.reason, students: [student] });
    }
  }

  return [...groups.values()]
    .map((group) => ({
      ...describe(group.reason, group.students.length),
      students: group.students.map((s) => ({ admissionNo: s.admissionNo, name: s.name })),
    }))
    .sort((a, b) => b.students.length - a.students.length);
}

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
      currentClassGroup: { select: { levelId: true, level: { select: { name: true } } } },
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

    const who = {
      admissionNo: student.admissionNo,
      name: `${student.firstName} ${student.lastName}`,
    };

    const levelId = student.currentClassGroup?.levelId;
    if (!levelId) {
      result.noStructure.push({ ...who, reason: { kind: "NO_CLASS" } });
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
      result.noStructure.push({
        ...who,
        reason: explainNoStructure(levelStructures, profile, termId, level),
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
