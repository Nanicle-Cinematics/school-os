/**
 * Work out what a save has to WRITE, given what is already stored.
 *
 * Both of the heavy saves (a class roll-up, a mark sheet) used to write every row they computed or were sent, a
 * statement each, inside one transaction holding one of the app role's four connections. Most of those rows
 * already said what was about to be written. Reading what is there once and writing only the difference is the
 * same final state for a fraction of the statements; see heavy-work.ts for why the statements are what costs.
 *
 * Pure: no Prisma client, no `server-only`, so a verify script can exercise it without a database.
 */
import { Prisma } from "@prisma/client";

/** Equal as stored: null and undefined are one thing, decimals compare by value, never by spelling. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  if (a instanceof Prisma.Decimal || b instanceof Prisma.Decimal) {
    return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(new Prisma.Decimal(b as Prisma.Decimal.Value));
  }
  return a === b;
}

/**
 * True only when EVERY listed column already holds what `next` would write. The safe direction: a value that does
 * not compare equal (a decimal with more places than the column keeps, say) simply gets written, as it always was.
 */
export function sameFields<K extends string>(
  existing: Record<K, unknown>,
  next: Record<string, unknown>,
  keys: readonly K[],
): boolean {
  return keys.every((key) => sameValue(existing[key], next[key]));
}

export type SheetCell = { assessmentId: string; studentId: string; rawScore: number | null; isAbsent: boolean };
export type StoredScore = {
  id: string;
  assessmentId: string;
  studentId: string;
  rawScore: Prisma.Decimal | null;
  isAbsent: boolean;
};

export type ScoreWrites = {
  /** Stored rows the sheet now leaves blank. */
  deletes: string[];
  /** Cells with a mark or an absence and no stored row. */
  creates: SheetCell[];
  /** Stored rows whose mark or absence changed. */
  updates: { id: string; cell: SheetCell }[];
  /** Cells that already said what was sent: nothing to write, and the original enterer stays on them. */
  unchanged: number;
};

/**
 * A mark sheet posts EVERY cell it shows, whether or not anyone touched it, so most of a save is cells that
 * already hold their value. A blank cell means "not marked yet", which is no row at all; a mark or an absence
 * is a row. Only a stored row that differs is rewritten, so a head who re-saves a teacher's sheet no longer
 * becomes the recorded enterer of every mark on it.
 */
export function planScoreWrites(cells: SheetCell[], stored: StoredScore[]): ScoreWrites {
  const have = new Map(stored.map((row) => [`${row.assessmentId}:${row.studentId}`, row]));
  const plan: ScoreWrites = { deletes: [], creates: [], updates: [], unchanged: 0 };

  for (const cell of cells) {
    const row = have.get(`${cell.assessmentId}:${cell.studentId}`);
    const blank = cell.rawScore === null && !cell.isAbsent;
    if (blank) {
      if (row) plan.deletes.push(row.id);
      else plan.unchanged += 1;
      continue;
    }
    if (!row) {
      plan.creates.push(cell);
    } else if (!sameValue(row.rawScore, cell.rawScore) || row.isAbsent !== cell.isAbsent) {
      plan.updates.push({ id: row.id, cell });
    } else {
      plan.unchanged += 1;
    }
  }
  return plan;
}
