import type { Stage } from "@prisma/client";
import { checkScore } from "@/lib/score-limits";

/**
 * The nursery progress report: a list of skills under each area (Language > News telling,
 * Poem recitals), each with a score out of 100 and an A/B/C rating.
 *
 * Pure, with no `server-only` and no database, so the setup form, the entry grid, the card and the
 * server actions all read the SAME rules. Which levels use it, what the ratings are called and how a
 * typed value is judged live here and nowhere else.
 */

/**
 * The stages whose report card is skills and ratings rather than marks out of 100.
 *
 * Nursery only, the school's decision (2026-10-22): KG and above keep the marked card. A stage is
 * the key rather than a per-level switch because the ladder is the same in every school, and a
 * switch is one more thing to set up and to get wrong. Widening this is one line.
 */
export const SKILL_CARD_STAGES: readonly Stage[] = ["NURSERY"];

export function usesSkillCard(stage: Stage | null | undefined): boolean {
  return Boolean(stage && SKILL_CARD_STAGES.includes(stage));
}

/** What a skill is rated, and the wording printed in the key on the card. Order is best first. */
export const SKILL_GRADES = ["A", "B", "C"] as const;
export type SkillGradeValue = (typeof SKILL_GRADES)[number];

export const SKILL_GRADE_LABEL: Record<SkillGradeValue, string> = {
  A: "Excellent",
  B: "Very good",
  C: "Good",
};

/** A skill's score is out of this, like every subject on the marked card. */
export const SKILL_SCORE_OUT_OF = 100;

/** A name longer than this does not fit a column of a printed card. */
export const SKILL_NAME_MAX = 60;
/** A sanity bound on one area, so a pasted document cannot become four hundred rows. */
export const SKILLS_PER_AREA_MAX = 30;

export type RatingCell = { score: string | null; grade: SkillGradeValue | null };

/** One typed rating: the grade is a letter from the key or blank, never anything else. */
export function checkSkillGrade(
  raw: string,
): { ok: true; grade: SkillGradeValue | null } | { ok: false; reason: string } {
  const text = raw.trim().toUpperCase();
  if (text === "") {
    return { ok: true, grade: null };
  }
  if ((SKILL_GRADES as readonly string[]).includes(text)) {
    return { ok: true, grade: text as SkillGradeValue };
  }
  return { ok: false, reason: `"${raw.trim()}" is not a rating; use ${SKILL_GRADES.join(", ")} or leave it blank` };
}

/** One typed score, by the same rule as a mark (`checkScore`), out of 100. */
export function checkSkillScore(raw: string) {
  return checkScore(raw, SKILL_SCORE_OUT_OF);
}

/**
 * The lines of a textarea as skill names: trimmed, blanks dropped, a repeat (in any case) dropped,
 * each cut to a printable length. `added` is what was kept; `tooMany` says the area's cap cut it off.
 */
export function splitSkillLines(text: string, alreadyHave: string[] = []) {
  const seen = new Set(alreadyHave.map((name) => name.trim().toLowerCase()));
  const added: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.replace(/\s+/g, " ").trim().slice(0, SKILL_NAME_MAX);
    if (!name || seen.has(name.toLowerCase())) {
      continue;
    }
    seen.add(name.toLowerCase());
    added.push(name);
  }
  const room = Math.max(0, SKILLS_PER_AREA_MAX - alreadyHave.length);
  return { added: added.slice(0, room), tooMany: added.length > room };
}

/**
 * A short code for a new area, as `saveSubject` would have the office type: capitals, no more than
 * six characters, and not one the school already uses. "Health and self help" becomes HEALTH, then
 * HEALTH2 if that is taken.
 */
export function areaCode(name: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((code) => code.toUpperCase()));
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const base = (words[0] ?? "AREA").slice(0, 6);
  if (!used.has(base)) {
    return base;
  }
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, 6 - String(n).length)}${n}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, 3)}${Date.now() % 1000}`;
}

/**
 * A child's age as printed on the form: whole years once they have one, otherwise months.
 * Counted to `on` (the end of the term), not today, so a card reprinted next year says what it said.
 */
export function ageLabel(dateOfBirth: Date | null | undefined, on: Date): string | null {
  if (!dateOfBirth || dateOfBirth > on) {
    return null;
  }
  let months =
    (on.getUTCFullYear() - dateOfBirth.getUTCFullYear()) * 12 + (on.getUTCMonth() - dateOfBirth.getUTCMonth());
  if (on.getUTCDate() < dateOfBirth.getUTCDate()) {
    months -= 1;
  }
  if (months < 0) {
    return null;
  }
  const years = Math.floor(months / 12);
  if (years >= 1) {
    return `${years} year${years === 1 ? "" : "s"}`;
  }
  return `${months} month${months === 1 ? "" : "s"}`;
}
