/**
 * The one rule for a typed mark: what it may be, and what it may not exceed.
 *
 * Pure, with no `server-only` and no database, so the two places that enforce it can use the SAME
 * function: the server actions (`saveScores`, `saveSheet`), which are the authority, and the grids
 * a person types into, which are a convenience that must not disagree with them. They used to hold
 * separate copies of the rule, and a copy that lives in a browser is one nobody tests.
 *
 * A mark is out of `Assessment.maxScore`, which is set for each component (Class Test 1 out of 10)
 * and, for a plain teacher or an IT admin, is not theirs to change. A mark above it is refused, not
 * trimmed: quietly turning a typed 15 into 10 would put a number in a child's record that nobody
 * typed.
 */

export type ScoreCheck = { ok: true; value: number | null } | { ok: false; reason: string };

/** Digits with an optional decimal part: what a person types for a mark, and nothing a script could. */
const PLAIN_NUMBER = /^(\d+(\.\d*)?|\.\d+)$/;

/**
 * One typed mark against what it is out of.
 *
 * Blank is "not marked yet", never zero: it means no row, whereas absent is its own flag and counts
 * as zero. Anything else must be a plain non-negative number no greater than `max`. `1e1` and `0x10`
 * are numbers to JavaScript and are not marks, so they are refused rather than read.
 */
export function checkScore(raw: string, max: number): ScoreCheck {
  const text = raw.trim();
  if (text === "") {
    return { ok: true, value: null };
  }
  if (text.startsWith("-")) {
    return { ok: false, reason: `${text} is below zero; a mark cannot be negative` };
  }
  if (!PLAIN_NUMBER.test(text)) {
    return { ok: false, reason: `"${text}" is not a mark; use a number such as 7 or 7.5` };
  }
  const value = Number(text);
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `"${text}" is not a mark; use a number such as 7 or 7.5` };
  }
  if (value > max) {
    return { ok: false, reason: `${text} is above the ${max} it is out of` };
  }
  return { ok: true, value };
}

/**
 * What a refused save says: who, which mark and why, for every one of them rather than the first.
 * "Scores cannot exceed the maximum" with no name left a teacher with forty pupils hunting for the
 * one they had mistyped, and a second save would then name the next.
 */
export function refusalMessage(problems: string[]): string {
  const shown = problems.slice(0, 5).join("; ");
  const more = problems.length > 5 ? `; and ${problems.length - 5} more` : "";
  return `Nothing was saved. ${shown}${more}.`;
}
