import { Prisma } from "@prisma/client";

/**
 * `amount` is deliberately loose. A Decimal does not survive the trip to a
 * client component — it arrives as a string — and this engine is used on both
 * sides, so the alternative is a cast at every call site, which is how a wrong
 * one eventually goes unnoticed.
 */
export type Instalment = {
  sequence: number;
  dueDate: Date;
  amount: Prisma.Decimal | number | string;
};

export type PlanStanding = {
  /** What the plan says should have arrived by now. */
  dueByNow: number;
  /** What actually has. */
  paid: number;
  /** Positive means behind the arrangement. */
  shortfall: number;
  onTrack: boolean;
  nextDue: { sequence: number; dueDate: Date; amount: number } | null;
};

/**
 * Is a family keeping to the arrangement?
 *
 * ⚠️ This compares payments against the SCHEDULE, not against the bill. A
 * parent who owes ₵900 of ₵1,200 is in arrears by the invoice and perfectly in
 * good standing by a plan that asked for ₵300 by today — and the whole reason
 * plans exist is that those two must not be treated the same. Chasing a parent
 * who is doing exactly what the school agreed is how a school loses a family it
 * had already kept.
 *
 * Tranches are counted as due once their date has PASSED — measured against the
 * start of today, so a tranche due today is not yet a shortfall. A bursar ringing at 8am about money agreed for
 * close of business is the same mistake in miniature.
 *
 * Payments are applied to the schedule in order, which is the only reading that
 * matches how anyone describes it: "she has paid the first two".
 */
export function planStanding(
  instalments: Instalment[],
  amountPaid: Prisma.Decimal | number | string,
  now = new Date(),
): PlanStanding {
  const paid = Number(amountPaid);
  const ordered = [...instalments].sort((a, b) => a.sequence - b.sequence);

  /**
   * ⚠️ Compared against the START OF TODAY, not against `now`.
   *
   * A due date is stored at midnight, so `dueDate <= now` makes a tranche due
   * TODAY already overdue from one second past midnight — and the guard caught
   * exactly that: the code said one thing and the paragraph above it said
   * another. A bursar ringing at 8am about money agreed for close of business
   * is the whole failure in miniature.
   */
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueByNow = ordered
    .filter((i) => i.dueDate < startOfToday)
    .reduce((total, i) => total + Number(i.amount), 0);

  const shortfall = Math.max(0, dueByNow - paid);

  // The next tranche the family still has to cover: walk the schedule spending
  // what has been paid, and stop at the first one not yet covered.
  let running = paid;
  let nextDue: PlanStanding["nextDue"] = null;
  for (const instalment of ordered) {
    const amount = Number(instalment.amount);
    if (running >= amount) {
      running -= amount;
      continue;
    }
    nextDue = { sequence: instalment.sequence, dueDate: instalment.dueDate, amount };
    break;
  }

  return { dueByNow, paid, shortfall, onTrack: shortfall <= 0.005, nextDue };
}

/**
 * Split a balance into equal tranches, last one carrying the rounding.
 *
 * Equal-and-then-adjust rather than equal-and-hope: three into ₵1,000 is
 * 333.33, 333.33, 333.34, and a schedule whose tranches do not sum to the bill
 * is a schedule a parent can satisfy while still owing a pesewa.
 */
export function splitEvenly(total: Prisma.Decimal | number | string, count: number): Prisma.Decimal[] {
  const amount = new Prisma.Decimal(total);
  if (count < 1) return [];
  const each = amount.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const parts = Array.from({ length: count }, () => each);
  const remainder = amount.sub(each.mul(count));
  parts[count - 1] = parts[count - 1].add(remainder);
  return parts;
}
