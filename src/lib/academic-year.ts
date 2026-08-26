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
