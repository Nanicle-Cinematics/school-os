import type { TermName } from "@prisma/client";

const SEQUENCE_NAME: Record<number, TermName> = { 1: "FIRST", 2: "SECOND", 3: "THIRD" };

/**
 * Split an academic year into three terms.
 *
 * Ghanaian schools always run three, so creating a year without them would leave
 * every term-scoped screen — invoicing, score entry — with nothing to attach to.
 * The even split is a starting point the office then corrects; real term dates
 * are set by GES and are never exactly even.
 *
 * Shared rather than private to the server action, so anything that creates a
 * year — the UI, a script, a future import — produces the same three terms.
 */
export function splitIntoTerms(start: Date, end: Date) {
  const span = end.getTime() - start.getTime();
  const step = Math.floor(span / 3);
  return [1, 2, 3].map((sequence) => {
    const termStart = new Date(start.getTime() + step * (sequence - 1));
    const termEnd =
      sequence === 3 ? new Date(end) : new Date(start.getTime() + step * sequence - 86_400_000);
    return { sequence, name: SEQUENCE_NAME[sequence], startDate: termStart, endDate: termEnd };
  });
}

/**
 * The academic year a date falls in, and the shape a Ghanaian school writes it.
 *
 * September, not January, is the boundary: a school set up in March belongs to
 * the year that opened the previous September, not the one about to start. From
 * August a school is preparing for the year ahead, so that is where it flips.
 *
 * These dates are a DEFAULT, not a claim — GES sets real term dates and they
 * move every year. The point is that a school opens with a calendar it can
 * correct, rather than with three screens that refuse to render until someone
 * builds one by hand.
 */
export function schoolYearFor(today: Date) {
  const opening = today.getUTCMonth() >= 7 ? today.getUTCFullYear() : today.getUTCFullYear() - 1;
  return {
    name: `${opening}/${opening + 1}`,
    startDate: new Date(Date.UTC(opening, 8, 1)),
    endDate: new Date(Date.UTC(opening + 1, 6, 31)),
  };
}

/**
 * "FIRST" → "First". A term's name is a Prisma enum, so it renders as a SHOUTED
 * word unless mapped — "FIRST Term · 2026/2027" reached the parent portal that
 * way, on a bill.
 *
 * Lives here because the same three-line map had been copy-pasted into eight
 * screens; a ninth screen that simply forgot it is exactly how the enum leaked
 * to a parent. Prefer this to writing the map again.
 */
const TERM_LABELS: Record<string, string> = {
  FIRST: "First",
  SECOND: "Second",
  THIRD: "Third",
};

export function termLabel(name: string) {
  return TERM_LABELS[name] ?? name;
}
