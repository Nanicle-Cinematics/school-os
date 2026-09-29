import "server-only";

import { Prisma } from "@prisma/client";
import type { Invoice, InvoiceStatus, Student } from "@prisma/client";
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

/**
 * The stored status: what has HAPPENED to this invoice.
 *
 * ⚠️ This used to return OVERDUE when the due date had passed, and that was a
 * lie waiting to happen — an invoice does not go late because somebody touched
 * it, it goes late because a Tuesday arrives. The only caller is
 * `recalcInvoice`, which runs on a payment, a reversal or an edited line, so an
 * unpaid invoice whose date quietly passed stayed ISSUED for ever. Dev held
 * **zero** OVERDUE rows and 26 unpaid invoices all due on the same day, every
 * one of which would have slid past it; meanwhile `/invoices` offered an
 * OVERDUE filter that returned nothing, which the office reads as "nobody is
 * late".
 *
 * So the stored status now records only what an EVENT decided — issued,
 * part-paid, paid, cancelled — and lateness is derived at read time by
 * `isOverdue` below. A stored field that rots on its own is the same animal as a
 * switch nothing reads.
 */
export function invoiceStatusFor(total: Prisma.Decimal, paid: Prisma.Decimal) {
  if (paid.greaterThanOrEqualTo(total) && total.greaterThan(0)) {
    return "PAID" as const;
  }
  if (paid.greaterThan(0)) {
    return "PARTIALLY_PAID" as const;
  }
  return "ISSUED" as const;
}

/** The shape every lateness question needs, and nothing more. */
export type Dateable = {
  status: InvoiceStatus;
  balance: Prisma.Decimal | number | string;
  dueDate: Date | null;
};

/**
 * Is this invoice late, right now?
 *
 * One rule, derived on every read, so it cannot go stale between a due date and
 * whatever next happens to touch the row. Lifted verbatim from the printed bill,
 * which had been getting this right at read time all along while the status
 * column next to it was wrong.
 *
 * A CANCELLED invoice is never late — the school withdrew the demand. Neither is
 * one with nothing left to pay, whatever its status says.
 */
export function isOverdue(invoice: Dateable, now = new Date()): boolean {
  if (invoice.status === "CANCELLED" || !invoice.dueDate) {
    return false;
  }
  return Number(invoice.balance) > 0 && invoice.dueDate < now;
}

/**
 * What to SHOW, which is the stored status unless it is late.
 *
 * OVERDUE stays in the enum because it is still real vocabulary for a reader —
 * it is simply never written to a row any more.
 */
export function displayStatus(invoice: Dateable, now = new Date()): InvoiceStatus {
  return isOverdue(invoice, now) ? "OVERDUE" : invoice.status;
}

/** How late, in whole days. Null when it is not. */
export function daysOverdue(invoice: Dateable, now = new Date()): number | null {
  if (!isOverdue(invoice, now) || !invoice.dueDate) {
    return null;
  }
  return Math.floor((now.getTime() - invoice.dueDate.getTime()) / 86_400_000);
}

/**
 * The `where` that answers a status filter on /invoices.
 *
 * ⚠️ Lives here, as a pure function, so it can be tested without a database —
 * and so the OVERDUE case cannot quietly drift back to `status: "OVERDUE"`,
 * which is a lookup that matches nothing and reads on screen as "nobody is
 * late". Same rule as `isOverdue`, expressed for Postgres.
 */
/**
 * How long a debt has been owed, in buckets.
 *
 * "Who owes" is not the question a bursar chasing fees is asking — a parent a
 * week late and one who has not paid since last term are the same row under a
 * `balance > 0` filter, and they need different phone calls. The buckets are
 * the 30/60/90 convention every Ghanaian accountant already reads off a bank
 * statement, so the screen needs no explaining.
 *
 * CURRENT covers both "not due yet" and "no due date set" — a bill with no
 * deadline is not late, it is unscheduled, and treating it as 90 days overdue
 * because it is old would have the office chasing parents who were never told
 * when to pay.
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

export function ageBucket(invoice: Dateable, now = new Date()): AgeBucket {
  const days = daysOverdue(invoice, now);
  if (days === null) return "CURRENT";
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  if (days <= 90) return "D61_90";
  return "D90_PLUS";
}

/**
 * The same buckets as a `where`, so a filter and a total cannot drift.
 *
 * Every one carries `balance > 0` and excludes CANCELLED: an ageing report is
 * about money still owed, and a settled invoice that was once late is not a
 * debt. Derived from the due date at read time for the same reason OVERDUE is —
 * nothing runs when a day passes.
 */
export function ageFilterWhere(bucket: AgeBucket | undefined, now = new Date()) {
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

export function statusFilterWhere(
  status: InvoiceStatus | "DEBTORS" | undefined,
  now = new Date(),
) {
  if (status === "DEBTORS") {
    return { balance: { gt: 0 }, status: { not: "CANCELLED" as const } };
  }
  if (status === "OVERDUE") {
    return {
      balance: { gt: 0 },
      dueDate: { not: null, lt: now },
      status: { not: "CANCELLED" as const },
    };
  }
  return status ? { status } : {};
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
          : invoiceStatusFor(total, amountPaid),
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
 * What one student's bill for a term COMES TO — the arithmetic alone.
 *
 * Extracted so that the pro-forma (`/invoices/proforma`) and the real generator
 * cannot disagree. They would: a pro-forma is a promise about what the bill
 * will be, and a second copy of "subtotal minus discounts plus arrears" drifts
 * the first time either side is edited alone — which in this codebase has
 * already happened to a CSV header, a payment-method label and an invoice
 * status. A parent shown one figure in July and billed another in September is
 * the money version of that, and it is the office that gets shouted at.
 *
 * Pure: it takes rows already read and returns Decimals. Nothing here touches
 * the database, so the pro-forma can price a term that has no invoices at all.
 */
export function priceFromStructure(
  schoolId: string,
  structure: { items: { feeCategoryId: string; amount: Prisma.Decimal; feeCategory: { name: string } }[] },
  discounts: Parameters<typeof discountForLine>[0],
  broughtForward: Prisma.Decimal,
) {
  const lines = structure.items.map((item) => ({
    schoolId,
    feeCategoryId: item.feeCategoryId,
    description: item.feeCategory.name,
    amount: item.amount,
    discount: discountForLine(discounts, item.feeCategoryId, item.amount),
  }));

  const subtotal = lines.reduce((acc, l) => acc.add(l.amount), new Prisma.Decimal(0));
  const discountTotal = lines.reduce((acc, l) => acc.add(l.discount), new Prisma.Decimal(0));
  const total = subtotal.sub(discountTotal).add(broughtForward);

  return { lines, subtotal, discountTotal, broughtForward, total };
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

  // A school provisioned before bill codes existed may not have TERMBILL yet —
  // generation must not fail over a missing classification, so this stays
  // optional rather than throwing when it's absent.
  const termBillCode = await tx.billCode.findUnique({
    where: { schoolId_code: { schoolId, code: "TERMBILL" } },
    select: { id: true },
  });

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

    const priced = priceFromStructure(
      schoolId,
      structure,
      student.discounts.map((sd) => sd.discount),
      previousBalances.get(student.id) ?? new Prisma.Decimal(0),
    );
    const { lines, subtotal, discountTotal, broughtForward, total } = priced;

    const invoiceNo = await nextNumber(tx, schoolId, "INVOICE", takenProbes.invoice(tx, schoolId));

    await tx.invoice.create({
      data: {
        schoolId,
        studentId: student.id,
        termId,
        billCodeId: termBillCode?.id,
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
 * What a pupil actually owes, ACROSS terms.
 *
 * ⚠️ Do NOT sum `invoice.balance` across terms. Each term's invoice carries the
 * previous term's unpaid balance forward into its own total, so the balances
 * are a CHAIN, not a list of separate debts — adding them counts the same money
 * once per term it has been owed. A child owing GH₵1,111 after three terms has
 * balances of 892, 881 and 1,111 sitting in the table, and summing them says
 * 2,884.
 *
 * Within ONE term, summing balances is correct and stays correct: that is the
 * running figure, and the dashboard, the debtor ageing and the invoice list are
 * all term-scoped. This is for the places that are not — the parent portal and
 * the debtor SMS audience, which look at a child's whole history.
 *
 * Charges minus payments, rather than "the latest invoice's balance", because
 * the chain is only trustworthy while nothing moves behind it: a reversed
 * receipt puts money back onto an OLD invoice that a newer one has already
 * carried forward, and the newest balance then understates. Subtracting
 * `broughtForward` removes the duplication at its source and leaves exactly
 * what the school charged.
 */
export function netOutstanding(
  invoices: { total: Prisma.Decimal; broughtForward: Prisma.Decimal }[],
  payments: { amount: Prisma.Decimal }[],
) {
  const charged = invoices.reduce(
    (acc, invoice) => acc.add(invoice.total).sub(invoice.broughtForward),
    new Prisma.Decimal(0),
  );
  const paid = payments.reduce((acc, payment) => acc.add(payment.amount), new Prisma.Decimal(0));
  // Never negative: a family in credit owes nothing, and "−GH₵50 outstanding"
  // on a portal reads as a debt to anyone scanning it.
  const owed = charged.sub(paid);
  return owed.isNegative() ? new Prisma.Decimal(0) : owed;
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
