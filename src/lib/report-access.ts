import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { money } from "@/lib/money";
import { planStanding } from "@/lib/plan-engine";

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
 *   - A family KEEPING TO AN AGREED PLAN is not held, even though the balance
 *     is positive. The school agreed the money would arrive later; withholding
 *     a card from a parent who is doing exactly what was agreed is the school
 *     going back on its own arrangement, and it is how a school loses a family
 *     it had already kept. Falling BEHIND the plan removes the exemption — the
 *     arrangement is the protection, not the existence of one.
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
 *
 * OVERDUE is kept for safety and no longer expected: lateness is derived at read
 * time now (`isOverdue`), so no row is written with that status. Listing it
 * costs nothing and means a legacy row could not slip a held card through.
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
    select: { invoiceNo: true, balance: true, amountPaid: true, ...PLAN_SELECT },
  });

  if (!invoice || money(invoice.balance).lte(0)) {
    return null;
  }
  if (keepingToPlan(invoice)) {
    return null;
  }
  return { balance: money(invoice.balance), invoiceNo: invoice.invoiceNo };
}

/** What a hold decision needs in order to see the arrangement. */
export const PLAN_SELECT = {
  paymentPlan: {
    select: {
      cancelledAt: true,
      instalments: { select: { sequence: true, dueDate: true, amount: true } },
    },
  },
} as const;

type WithPlan = {
  amountPaid: Prisma.Decimal;
  paymentPlan: {
    cancelledAt: Date | null;
    instalments: { sequence: number; dueDate: Date; amount: Prisma.Decimal }[];
  } | null;
};

/**
 * Is this bill covered by an arrangement the family is keeping to?
 *
 * A cancelled plan protects nobody, and a plan with no instalments is not an
 * arrangement — both fall through to the ordinary arrears rule rather than
 * silently exempting a debt.
 */
export function keepingToPlan(invoice: WithPlan, now = new Date()): boolean {
  const plan = invoice.paymentPlan;
  if (!plan || plan.cancelledAt || plan.instalments.length === 0) {
    return false;
  }
  return planStanding(plan.instalments, invoice.amountPaid, now).onTrack;
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
    select: { studentId: true, invoiceNo: true, balance: true, amountPaid: true, ...PLAN_SELECT },
  });

  // Still one query: the plan and its instalments come back with the invoice,
  // so a forty-child print run does not become forty plan lookups.
  return index(
    invoices.filter((invoice) => !keepingToPlan(invoice)),
    (invoice) => invoice.studentId,
  );
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
    select: { termId: true, invoiceNo: true, balance: true, amountPaid: true, ...PLAN_SELECT },
  });

  // The parent's own list obeys the arrangement too — this is the reader a
  // family actually looks at, so leaving it out would have the portal hiding a
  // card the office can see is free to go home.
  return index(
    invoices.filter((invoice) => !keepingToPlan(invoice)),
    (invoice) => invoice.termId,
  );
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
