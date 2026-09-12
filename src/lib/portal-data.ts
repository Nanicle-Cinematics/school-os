import "server-only";

import { prisma } from "@/lib/prisma";
import { sum } from "@/lib/money";
import { reportHold, reportHoldsForTerms } from "@/lib/report-access";

/**
 * Reads for the parent portal.
 *
 * Every function here takes the student ids the SESSION resolved (see
 * portal-auth.ts) rather than an id from the request. That is deliberate: RLS
 * scopes these queries to the school, so a raw studentId from a URL would
 * satisfy Postgres perfectly well while belonging to another family.
 *
 * Queries are awaited in sequence, not fanned out with Promise.all: production
 * pins `connection_limit=1`, so parallel queries queue for one connection and
 * the tail of a fan-out blows past Prisma's pool timeout. See CLAUDE.md.
 */

/** A parent's landing list: each child, their class, and what is owed. */
export async function getMyChildren(studentIds: string[]) {
  if (studentIds.length === 0) return [];

  const students = await prisma.student.findMany({
    where: { id: { in: studentIds }, deletedAt: null },
    select: {
      id: true,
      firstName: true,
      middleName: true,
      lastName: true,
      admissionNo: true,
      photoUrl: true,
      status: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // One grouped query rather than one per child: a family with four children
  // would otherwise be four round trips to Frankfurt on a slow link.
  const owed = await prisma.invoice.groupBy({
    by: ["studentId"],
    where: { studentId: { in: studentIds }, status: { not: "DRAFT" } },
    _sum: { balance: true },
  });
  const owedBy = new Map(owed.map((row) => [row.studentId, row._sum.balance]));

  // A report card the school has not published is not a parent's to see, so the
  // count is of PUBLISHED rows only — the portal never reveals that an
  // unpublished one exists.
  const published = await prisma.termResult.groupBy({
    by: ["studentId"],
    where: { studentId: { in: studentIds }, status: "PUBLISHED" },
    _count: { _all: true },
  });
  const cardsBy = new Map(published.map((row) => [row.studentId, row._count._all]));

  return students.map((s) => ({
    ...s,
    balance: owedBy.get(s.id) ?? null,
    reportCards: cardsBy.get(s.id) ?? 0,
  }));
}

/** The terms a child actually has a PUBLISHED report card for, newest first. */
export async function getPublishedTerms(studentId: string) {
  const rows = await prisma.termResult.findMany({
    where: { studentId, status: "PUBLISHED" },
    select: {
      termId: true,
      average: true,
      classPosition: true,
      classSize: true,
      publishedAt: true,
      term: {
        select: {
          name: true,
          startDate: true,
          academicYear: { select: { name: true } },
        },
      },
    },
    orderBy: { term: { startDate: "desc" } },
  });

  /**
   * ⚠️ The list carries the average and the position, so a hold that only
   * covered the card itself would withhold nothing that matters — the headline
   * numbers would still be sitting on the page one level up. Held terms are
   * marked here and the summary is dropped with them.
   */
  const settings = await prisma.schoolSettings.findFirst({
    select: { blockReportOnArrears: true, showClassPosition: true },
  });
  const holds = await reportHoldsForTerms(
    studentId,
    rows.map((row) => row.termId),
    settings,
  );
  const showPosition = settings?.showClassPosition ?? true;

  return rows.map((row) => {
    const hold = holds.get(row.termId) ?? null;
    return {
      ...row,
      hold,
      // Nothing about the result travels while it is held.
      average: hold ? null : row.average,
      classPosition: hold || !showPosition ? null : row.classPosition,
      classSize: hold || !showPosition ? null : row.classSize,
    };
  });
}

/** Invoices and receipts for one child, newest term first. */
export async function getChildFinance(studentId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { studentId, status: { not: "DRAFT" } },
    select: {
      id: true,
      invoiceNo: true,
      issueDate: true,
      dueDate: true,
      total: true,
      amountPaid: true,
      balance: true,
      broughtForward: true,
      status: true,
      term: { select: { name: true, academicYear: { select: { name: true } } } },
    },
    orderBy: { issueDate: "desc" },
  });

  // Reversed payments are excluded: a receipt that was voided is not money the
  // parent has paid, and showing it would contradict the balance above it.
  const payments = await prisma.payment.findMany({
    where: { studentId, reversedAt: null, status: "CONFIRMED" },
    select: {
      id: true,
      receiptNo: true,
      amount: true,
      method: true,
      momoNetwork: true,
      reference: true,
      paidAt: true,
    },
    orderBy: { paidAt: "desc" },
  });

  return {
    invoices,
    payments,
    outstanding: sum(invoices.map((i) => i.balance)),
    paidTotal: sum(payments.map((p) => p.amount)),
  };
}

/**
 * A report card, but ONLY if the school has published it.
 *
 * `getReportCard` in results-data.ts does not check status — staff are allowed
 * to read a draft, which is the point of the approval flow. A parent is not, so
 * the publication check happens FIRST and the card is not even fetched
 * otherwise. Returning null (rendered as 404) rather than "not published yet"
 * keeps the portal from confirming that an unpublished result exists.
 */
export async function getPublishedReportCard(studentId: string, termId: string) {
  const published = await prisma.termResult.findFirst({
    where: { studentId, termId, status: "PUBLISHED" },
    select: { id: true },
  });
  if (!published) return null;

  const { getReportCard } = await import("@/lib/results-data");
  const data = await getReportCard(termId, studentId);
  if (!data) return null;

  /**
   * The one place a withheld card is actually withheld from a family.
   *
   * Returned as a HOLD rather than a 404: a parent who is told the page does
   * not exist rings the school, and the office then explains what the software
   * should have. The amount and the school's own payment instructions are
   * handed back instead, so the message is "settle this and collect it" rather
   * than "something is broken".
   */
  const hold = await reportHold(studentId, termId, data.settings);
  if (hold) {
    return {
      held: true as const,
      hold,
      // Already loaded with the card — no second read for the same row.
      paymentInstructions: data.settings?.paymentInstructions ?? null,
    };
  }

  return { held: false as const, ...data };
}

/** Name, class and admission number — the header every portal page carries. */
export async function getChildHeader(studentId: string) {
  return prisma.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      firstName: true,
      middleName: true,
      lastName: true,
      admissionNo: true,
      photoUrl: true,
      status: true,
      currentClassGroup: { select: { name: true, level: { select: { name: true } } } },
    },
  });
}
