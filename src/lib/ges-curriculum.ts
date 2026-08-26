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
 *   - OWOP and History exist only in B1–B6; at B7 they merge into Social Studies.
 *   - "Creative Arts" (B1–B6) becomes "Creative Arts and Design" at JHS.
 *   - French and Computing start at B4, not B1.
 *   - Arabic and Career Technology are JHS-only.
 *   - PE is "Physical Education" in B1–B6 and "Physical Health" in B7–B9 — the
 *     same lineage under two names, so continuity checks should treat them as one.
 */

export const GES_LEVELS: { code: string; name: string; stage: Stage; order: number }[] = [
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

const KG = ["KG1", "KG2"];
const LOWER = ["B1", "B2", "B3"];
const UPPER = ["B4", "B5", "B6"];
const JHS = ["B7", "B8", "B9"];
const PRIMARY = [...LOWER, ...UPPER];

/** `levels` lists the level codes that actually offer the subject. */
export const GES_SUBJECTS: { code: string; name: string; order: number; levels: string[] }[] = [
  // KG thematic areas. Creative Arts and OWOP continue into primary as subjects,
  // so they are shared rows rather than duplicates.
  { code: "NUM", name: "Numeracy", order: 10, levels: KG },
  { code: "LIT", name: "Literacy", order: 20, levels: KG },

  { code: "ENG", name: "English", order: 30, levels: [...PRIMARY, ...JHS] },
  { code: "MAT", name: "Mathematics", order: 40, levels: [...PRIMARY, ...JHS] },
  { code: "SCI", name: "Science", order: 50, levels: [...PRIMARY, ...JHS] },
  { code: "OWOP", name: "Our World Our People", order: 60, levels: [...KG, ...PRIMARY] },
  { code: "HIS", name: "History", order: 70, levels: PRIMARY },
  { code: "SOC", name: "Social Studies", order: 80, levels: JHS },
  { code: "RME", name: "Religious and Moral Education", order: 90, levels: [...PRIMARY, ...JHS] },
  { code: "GHL", name: "Ghanaian Language", order: 100, levels: [...PRIMARY, ...JHS] },
  { code: "CA", name: "Creative Arts", order: 110, levels: [...KG, ...PRIMARY] },
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

  const levelIdByCode = new Map<string, string>();
  for (const level of GES_LEVELS) {
    const existing = await tx.level.findFirst({ where: { schoolId, code: level.code } });
    if (existing) {
      levelIdByCode.set(level.code, existing.id);
      result.skipped += 1;
      continue;
    }
    const created = await tx.level.create({ data: { schoolId, ...level } });
    levelIdByCode.set(level.code, created.id);
    result.levelsCreated += 1;
  }

  for (const subject of GES_SUBJECTS) {
    let record = await tx.subject.findFirst({ where: { schoolId, code: subject.code } });
    if (record) {
      result.skipped += 1;
    } else {
      record = await tx.subject.create({
        data: {
          schoolId,
          code: subject.code,
          name: subject.name,
          order: subject.order,
          isCore: true,
        },
      });
      result.subjectsCreated += 1;
    }

    for (const levelCode of subject.levels) {
      const levelId = levelIdByCode.get(levelCode);
      if (!levelId) continue;

      const link = await tx.levelSubject.findFirst({
        where: { levelId, subjectId: record.id },
      });
      if (link) {
        result.skipped += 1;
        continue;
      }
      await tx.levelSubject.create({
        data: {
          schoolId,
          levelId,
          subjectId: record.id,
          isElective: false,
          countsForAggregate: true,
          order: subject.order,
        },
      });
      result.linksCreated += 1;
    }
  }

  return result;
}
