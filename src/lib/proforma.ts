import { Prisma } from "@prisma/client";
import type { PromotionStatus } from "@prisma/client";

/**
 * The two decisions an advance bill has to make that a bill for the CURRENT term never does: what a
 * family still owes from the terms before it, and which level a child will be in when the term starts.
 *
 * Pure, with no `server-only` and no database, so `verify:proforma` can walk every case. The advance
 * bill (`/invoices/proforma`) is a promise about what the real invoice will say, so both rules
 * deliberately mirror the real generator rather than approximate it.
 */

export type TermPosition = { yearStart: Date; sequence: number };

/** Is `a` strictly earlier than `b`, in the order invoices are chained: year start, then term. */
export function isEarlier(a: TermPosition, b: TermPosition): boolean {
  const byYear = a.yearStart.getTime() - b.yearStart.getTime();
  return byYear !== 0 ? byYear < 0 : a.sequence < b.sequence;
}

export type EarlierInvoice = {
  studentId: string;
  balance: Prisma.Decimal;
  term: { name: string; sequence: number; academicYear: { name: string; startDate: Date } };
};

/**
 * What each pupil still owes from before `target`: the balance of their LATEST earlier invoice.
 *
 * ⚠️ This is what the real chain does (`relinkChain` in invoice-engine.ts): every invoice carries the
 * balance of the one before it in (year, term) order, and that balance already contains whatever IT
 * carried, so the latest earlier invoice alone is the whole arrears. Two things the first version of
 * the advance bill got wrong, both visible exactly when it matters:
 *
 *  - it looked for the previous term INSIDE the same academic year, so the third term's bill for the
 *    next year's first term found no previous term and quoted no arrears at all;
 *  - it looked at the term immediately before, so a term that was never invoiced hid everything owed
 *    from the one before that.
 *
 * Only a positive balance is carried (a credit is not arrears), and a pupil with nothing owed is simply
 * absent from the map. `from` names the term it is owed from, for the line on the bill.
 */
export function arrearsBefore(
  invoices: EarlierInvoice[],
  target: TermPosition,
): Map<string, { amount: Prisma.Decimal; from: string }> {
  const latest = new Map<string, EarlierInvoice>();
  for (const invoice of invoices) {
    const position = { yearStart: invoice.term.academicYear.startDate, sequence: invoice.term.sequence };
    if (!isEarlier(position, target)) {
      continue;
    }
    const held = latest.get(invoice.studentId);
    const heldPosition = held
      ? { yearStart: held.term.academicYear.startDate, sequence: held.term.sequence }
      : null;
    if (!heldPosition || isEarlier(heldPosition, position)) {
      latest.set(invoice.studentId, invoice);
    }
  }

  const owed = new Map<string, { amount: Prisma.Decimal; from: string }>();
  for (const [studentId, invoice] of latest) {
    if (invoice.balance.greaterThan(0)) {
      owed.set(studentId, {
        amount: invoice.balance,
        from: `${TERM_NAME[invoice.term.name] ?? invoice.term.name} Term · ${invoice.term.academicYear.name}`,
      });
    }
  }
  return owed;
}

const TERM_NAME: Record<string, string> = { FIRST: "First", SECOND: "Second", THIRD: "Third" };

export type Rung = { id: string; order: number };

export type LevelChoice =
  | { kind: "ENROLLED"; levelId: string }
  | { kind: "PROMOTED"; levelId: string }
  /** Stays where they are. `assumed` when the year ended with no decision, so the office should look. */
  | { kind: "SAME"; levelId: string; assumed: boolean }
  | { kind: "GRADUATING" }
  | { kind: "NO_CLASS" };

/**
 * Which level a child will be billed at in the coming term.
 *
 * Within a year it is the class they are placed in. Across a year it is NOT the class they sit in today:
 * the bill is printed at the end of the third term, before the promotion has run, and quoting a Basic 1
 * fee to a child who will be in Basic 2 is the wrong amount in the right layout. So when they have no
 * placement in the coming year yet, the year's own verdict decides (`promotionStatus` on their third
 * term): promoted goes one rung up, repeating stays, graduating is not billed at all.
 *
 * A child with no decision recorded is priced where they are and marked `assumed`, so the page can say
 * how many were guessed instead of quietly printing them.
 */
export function levelForNextTerm(args: {
  /** The level of the class they are placed in for the coming term's year, if they are placed. */
  enrolledLevelId: string | null;
  /** The level of the class they sit in now. */
  currentLevel: Rung | null;
  /** The verdict on their last year, when there is one. Ignored once they are placed. */
  decision: PromotionStatus | null;
  ladder: Rung[];
  /** The coming term starts a later academic year than today's. */
  crossesYear: boolean;
}): LevelChoice {
  if (args.enrolledLevelId) {
    return { kind: "ENROLLED", levelId: args.enrolledLevelId };
  }
  const current = args.currentLevel;
  if (!current) {
    return { kind: "NO_CLASS" };
  }
  if (args.decision === "GRADUATED") {
    return { kind: "GRADUATING" };
  }
  if (args.decision === "PROMOTED") {
    const above = args.ladder.filter((rung) => rung.order > current.order).sort((a, b) => a.order - b.order)[0];
    return above ? { kind: "PROMOTED", levelId: above.id } : { kind: "GRADUATING" };
  }
  const decided = args.decision === "REPEATED";
  return { kind: "SAME", levelId: current.id, assumed: args.crossesYear && !decided };
}
