import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { money } from "@/lib/money";

/**
 * Whether a report card may go home, given what the family owes.
 *
 * ⚠️ `blockReportOnArrears` was a checkbox that did NOTHING for the whole of its
 * life. `/settings` promised "Withhold report cards from students in arrears",
 * saved the answer, and every card printed and published regardless — so a head
 * teacher who ticked it, trusted it and let the term run out discovered at
 * vacation that every card had already gone home and the term's fees had gone
 * with them. Same shape as `notifyOnPayment` and `studentCap` before it, which
 * is why `verify:settings` now refuses to let a fifth one ship.
 *
 * The rule, in one place because it decides whether a family sees their child's
 * results:
 *
 *   - The school must have ASKED. No invoice for the term, or one still in
 *     DRAFT, or a CANCELLED one, means nothing has been billed — a card is never
 *     withheld for a bill the office has not sent. Withholding on an unsent
 *     invoice would punish a family for the office's backlog.
 *   - The balance must be POSITIVE. Zero, or a credit, is not arrears.
 *   - `broughtForward` is already inside that balance (see the Invoice model),
 *     so the term's own invoice is the whole picture and there is no second
 *     query looking for older debt.
 *
 * And who a hold applies to, which is the part worth being careful about:
 *
 *   - PARENTS are held. That is the entire point of the setting.
 *   - STAFF are not. The office has to be able to open the card to tell the
 *     parent what is owed and what they are collecting once it is paid, and a
 *     school withholding a record from ITSELF helps nobody.
 *   - The PRINT RUN is held, because a class print is exactly how a withheld
 *     card leaves the building by accident.
 */

export type ReportHold = {
  /** GHS still owed on the term's invoice. */
  balance: Prisma.Decimal;
  invoiceNo: string;
};

type HoldSettings = { blockReportOnArrears: boolean } | null | undefined;

/**
 * Invoices that represent a real request for money.
 *
 * Exported so `verify:settings` can assert what is NOT in it: a DRAFT or
 * CANCELLED invoice must never hold a card, and the seed happens to contain
 * neither, so a check that waited for one to turn up would never run.
 */
export const BILLED = ["ISSUED", "PARTIALLY_PAID", "OVERDUE"] as const;

/**
 * The hold on one card, or null when it may go home.
 *
 * `settings` is passed in rather than read here: every caller has already loaded
 * it for the card itself, and a second read per student would double the query
 * count of a forty-child print run.
 */
export async function reportHold(
  studentId: string,
  termId: string,
  settings: HoldSettings,
): Promise<ReportHold | null> {
  if (!settings?.blockReportOnArrears) {
    return null;
  }

  const invoice = await prisma.invoice.findFirst({
    where: { studentId, termId, status: { in: [...BILLED] } },
    select: { invoiceNo: true, balance: true },
  });

  if (!invoice || money(invoice.balance).lte(0)) {
    return null;
  }
  return { balance: money(invoice.balance), invoiceNo: invoice.invoiceNo };
}

/**
 * The same question for a whole class in one term, in one query.
 *
 * Returns a map keyed by studentId holding only the students who are held, so
 * `holds.get(id)` is the hold and a miss means the card is free to print.
 */
export async function reportHoldsForClass(
  studentIds: string[],
  termId: string,
  settings: HoldSettings,
): Promise<Map<string, ReportHold>> {
  if (!settings?.blockReportOnArrears || studentIds.length === 0) {
    return new Map();
  }

  const invoices = await prisma.invoice.findMany({
    where: { termId, studentId: { in: studentIds }, status: { in: [...BILLED] } },
    select: { studentId: true, invoiceNo: true, balance: true },
  });

  return index(invoices, (invoice) => invoice.studentId);
}

/**
 * And for one child across several terms — a parent's list of report cards.
 *
 * The mirror of the class reader: same rule, same single query, keyed by termId
 * instead. A parent with four published terms is not four round trips.
 */
export async function reportHoldsForTerms(
  studentId: string,
  termIds: string[],
  settings: HoldSettings,
): Promise<Map<string, ReportHold>> {
  if (!settings?.blockReportOnArrears || termIds.length === 0) {
    return new Map();
  }

  const invoices = await prisma.invoice.findMany({
    where: { studentId, termId: { in: termIds }, status: { in: [...BILLED] } },
    select: { termId: true, invoiceNo: true, balance: true },
  });

  return index(invoices, (invoice) => invoice.termId);
}

/** Keep only the invoices actually in arrears, keyed by whatever the caller asked. */
function index<T extends { invoiceNo: string; balance: Prisma.Decimal }>(
  invoices: T[],
  key: (invoice: T) => string,
): Map<string, ReportHold> {
  const held = new Map<string, ReportHold>();
  for (const invoice of invoices) {
    const balance = money(invoice.balance);
    if (balance.gt(0)) {
      held.set(key(invoice), { balance, invoiceNo: invoice.invoiceNo });
    }
  }
  return held;
}
