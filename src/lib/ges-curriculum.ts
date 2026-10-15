import "server-only";

import type { Stage } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";

/**
 * The GES/NaCCA subject structure, as ground truth for onboarding a school.
 *
 * Every school starts with this rather than an empty ladder, because the
 * alternative is each one retyping the national curriculum and getting the
 * transitions subtly wrong. A school that genuinely differs edits it afterwards
 * — the structure is a baseline, not a constraint.
 *
 * The transitions are the part worth getting right, and the part a hand-built
 * list usually fumbles:
 *   - KG is NOT taught as discrete subjects. It is four thematic areas, and
 *     Mathematics/Science must not appear there.
 *   - NURSERY 1 and 2 sit below KG and take the SAME four thematic areas. There
 *     is no separate national subject curriculum for under-fives, and the app has
 *     no other model for them, so they get the KG framework (and so a mark sheet
 *     and a report card) rather than an empty offering list. A school that works
 *     differently edits it afterwards, like everything else here.
 *   - OWOP and History exist only in B1–B6; at B7 they merge into Social Studies.
 *   - "Creative Arts" (B1–B6) becomes "Creative Arts and Design" at JHS.
 *   - French and Computing start at B4, not B1.
 *   - Arabic and Career Technology are JHS-only.
 *   - PE is "Physical Education" in B1–B6 and "Physical Health" in B7–B9 — the
 *     same lineage under two names, so continuity checks should treat them as one.
 */

export const GES_LEVELS: { code: string; name: string; stage: Stage; order: number }[] = [
  // ⚠️ Nursery sits BELOW KG1, whose stored order is 1 in every school that already exists, and
  // `applyGesCurriculum` only ever CREATES levels: it never renumbers one. So the new rungs take the
  // orders before it (-1 and 0) rather than pushing everything else up, which would collide with
  // KG1 in a school created earlier. The ladder must stay CONSECUTIVE: paper records work out "that
  // many rungs down" by subtracting from `order` (records-engine.ts), and promotion finds the level
  // above as the next order up. `verify:ges-baseline` pins both.
  { code: "N1", name: "Nursery 1", stage: "NURSERY", order: -1 },
  { code: "N2", name: "Nursery 2", stage: "NURSERY", order: 0 },
  { code: "KG1", name: "Kindergarten 1", stage: "KINDERGARTEN", order: 1 },
  { code: "KG2", name: "Kindergarten 2", stage: "KINDERGARTEN", order: 2 },
  { code: "B1", name: "Basic 1", stage: "PRIMARY", order: 3 },
  { code: "B2", name: "Basic 2", stage: "PRIMARY", order: 4 },
  { code: "B3", name: "Basic 3", stage: "PRIMARY", order: 5 },
  { code: "B4", name: "Basic 4", stage: "PRIMARY", order: 6 },
  { code: "B5", name: "Basic 5", stage: "PRIMARY", order: 7 },
  { code: "B6", name: "Basic 6", stage: "PRIMARY", order: 8 },
  { code: "B7", name: "JHS 1", stage: "JHS", order: 9 },
  { code: "B8", name: "JHS 2", stage: "JHS", order: 10 },
  { code: "B9", name: "JHS 3", stage: "JHS", order: 11 },
];

const NURSERY = ["N1", "N2"];
const KG = ["KG1", "KG2"];
/** The years that take the four thematic areas rather than discrete subjects. */
const EARLY_YEARS = [...NURSERY, ...KG];
const LOWER = ["B1", "B2", "B3"];
const UPPER = ["B4", "B5", "B6"];
const JHS = ["B7", "B8", "B9"];
const PRIMARY = [...LOWER, ...UPPER];

/** `levels` lists the level codes that actually offer the subject. */
export const GES_SUBJECTS: { code: string; name: string; order: number; levels: string[] }[] = [
  // The thematic areas of nursery and KG. Creative Arts and OWOP continue into primary as subjects,
  // so they are shared rows rather than duplicates.
  { code: "NUM", name: "Numeracy", order: 10, levels: EARLY_YEARS },
  { code: "LIT", name: "Literacy", order: 20, levels: EARLY_YEARS },

  { code: "ENG", name: "English", order: 30, levels: [...PRIMARY, ...JHS] },
  { code: "MAT", name: "Mathematics", order: 40, levels: [...PRIMARY, ...JHS] },
  { code: "SCI", name: "Science", order: 50, levels: [...PRIMARY, ...JHS] },
  { code: "OWOP", name: "Our World Our People", order: 60, levels: [...EARLY_YEARS, ...PRIMARY] },
  { code: "HIS", name: "History", order: 70, levels: PRIMARY },
  { code: "SOC", name: "Social Studies", order: 80, levels: JHS },
  { code: "RME", name: "Religious and Moral Education", order: 90, levels: [...PRIMARY, ...JHS] },
  { code: "GHL", name: "Ghanaian Language", order: 100, levels: [...PRIMARY, ...JHS] },
  { code: "CA", name: "Creative Arts", order: 110, levels: [...EARLY_YEARS, ...PRIMARY] },
  { code: "CAD", name: "Creative Arts and Design", order: 120, levels: JHS },
  { code: "PE", name: "Physical Education", order: 130, levels: PRIMARY },
  { code: "PHE", name: "Physical Health", order: 140, levels: JHS },
  { code: "FRE", name: "French", order: 150, levels: [...UPPER, ...JHS] },
  { code: "COM", name: "Computing", order: 160, levels: [...UPPER, ...JHS] },
  { code: "ARA", name: "Arabic", order: 170, levels: JHS },
  { code: "CTE", name: "Career Technology", order: 180, levels: JHS },
];

export type CurriculumResult = {
  levelsCreated: number;
  subjectsCreated: number;
  linksCreated: number;
  skipped: number;
};

/**
 * Create the GES ladder and subject offerings for a school.
 *
 * Idempotent: levels and subjects are matched on their code, which is unique per
 * school, so running it against a school that already has some of them fills in
 * the gaps instead of failing or duplicating. Nothing is renamed or deleted — a
 * school that has customised a name keeps it.
 */
export async function applyGesCurriculum(
  tx: TenantTx,
  schoolId: string,
): Promise<CurriculumResult> {
  const result: CurriculumResult = {
    levelsCreated: 0,
    subjectsCreated: 0,
    linksCreated: 0,
    skipped: 0,
  };

  // Read what is there, write what is missing, in bulk. The row-at-a-time
  // version of this made ~270 sequential round trips — 11 levels, 18 subjects
  // and 104 offerings, each preceded by its own existence check — and
  // `DATABASE_URL` pins `connection_limit=1`, so they queue. On a slow link that
  // took over seven minutes and blew the provisioning transaction's own timeout,
  // leaving the school committed but the console reporting failure. Six round
  // trips cannot do that.

  const existingLevels = await tx.level.findMany({
    where: { schoolId, code: { in: GES_LEVELS.map((level) => level.code) } },
    select: { id: true, code: true },
  });
  const levelIdByCode = new Map(existingLevels.map((level) => [level.code, level.id]));
  result.skipped += existingLevels.length;

  const missingLevels = GES_LEVELS.filter((level) => !levelIdByCode.has(level.code));
  if (missingLevels.length > 0) {
    const created = await tx.level.createManyAndReturn({
      data: missingLevels.map((level) => ({ schoolId, ...level })),
      select: { id: true, code: true },
    });
    for (const level of created) levelIdByCode.set(level.code, level.id);
    result.levelsCreated += created.length;
  }

  const existingSubjects = await tx.subject.findMany({
    where: { schoolId, code: { in: GES_SUBJECTS.map((subject) => subject.code) } },
    select: { id: true, code: true },
  });
  const subjectIdByCode = new Map(existingSubjects.map((subject) => [subject.code, subject.id]));
  result.skipped += existingSubjects.length;

  const missingSubjects = GES_SUBJECTS.filter((subject) => !subjectIdByCode.has(subject.code));
  if (missingSubjects.length > 0) {
    const created = await tx.subject.createManyAndReturn({
      data: missingSubjects.map((subject) => ({
        schoolId,
        code: subject.code,
        name: subject.name,
        order: subject.order,
        isCore: true,
      })),
      select: { id: true, code: true },
    });
    for (const subject of created) subjectIdByCode.set(subject.code, subject.id);
    result.subjectsCreated += created.length;
  }

  // Offerings the school already has, keyed the way the unique pair is.
  const subjectIds = [...subjectIdByCode.values()];
  const existingLinks =
    subjectIds.length > 0
      ? await tx.levelSubject.findMany({
          where: { schoolId, subjectId: { in: subjectIds } },
          select: { levelId: true, subjectId: true },
        })
      : [];
  const linked = new Set(existingLinks.map((link) => `${link.levelId}:${link.subjectId}`));

  const newLinks: {
    schoolId: string;
    levelId: string;
    subjectId: string;
    isElective: boolean;
    countsForAggregate: boolean;
    order: number;
  }[] = [];

  for (const subject of GES_SUBJECTS) {
    const subjectId = subjectIdByCode.get(subject.code);
    if (!subjectId) continue;

    for (const levelCode of subject.levels) {
      const levelId = levelIdByCode.get(levelCode);
      if (!levelId) continue;
      if (linked.has(`${levelId}:${subjectId}`)) {
        result.skipped += 1;
        continue;
      }
      // Guard against the same pair appearing twice in one batch, which
      // `createMany` would reject on the unique constraint.
      linked.add(`${levelId}:${subjectId}`);
      newLinks.push({
        schoolId,
        levelId,
        subjectId,
        isElective: false,
        countsForAggregate: true,
        order: subject.order,
      });
    }
  }

  if (newLinks.length > 0) {
    const created = await tx.levelSubject.createMany({ data: newLinks });
    result.linksCreated += created.count;
  }

  return result;
}
