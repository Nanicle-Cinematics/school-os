import "server-only";

import type { Stage } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { SKILL_CARD_STAGES, usesSkillCard, type RatingCell } from "@/lib/skills";
import { termRoster } from "@/lib/sheet-data";

/**
 * Everything the nursery skills report reads and writes against, in the shapes the screens use.
 *
 * Sequential queries throughout, never a `Promise.all`: the app role holds four connections and each
 * query under row security holds one for several round trips (CLAUDE.md, "Don't fan a page's queries
 * out past the pool").
 */

/** One area of the card and the skills listed under it, in the order they print. */
export type SkillSection = {
  subjectId: string;
  subjectName: string;
  skills: { id: string; name: string }[];
};

/**
 * What a nursery card needs besides the pupil: the level's sections, and each pupil's rating per
 * skill. Plain objects, not Maps, so the same value can be handed to a card or to a client component.
 */
export type SkillCardData = {
  sections: SkillSection[];
  ratings: Record<string, Record<string, RatingCell>>;
};

function cellOf(row: { score: unknown; grade: string | null }): RatingCell {
  return {
    score: row.score === null || row.score === undefined ? null : String(Number(row.score)),
    grade: (row.grade ?? null) as RatingCell["grade"],
  };
}

/**
 * The areas a level reports on, and the skills under each, in print order: the level's own subject
 * order first (so the card reads as the school lists its subjects), then the skill's order.
 * An area with no skills is left out: it has nothing to print.
 */
export async function getSkillSections(levelId: string): Promise<SkillSection[]> {
  const skills = await prisma.subjectSkill.findMany({
    where: { levelId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, name: true, subjectId: true, subject: { select: { name: true, order: true } } },
  });
  if (skills.length === 0) {
    return [];
  }
  const offered = await prisma.levelSubject.findMany({
    where: { levelId },
    select: { subjectId: true, order: true },
  });
  const levelOrder = new Map(offered.map((row) => [row.subjectId, row.order]));

  const sections = new Map<string, { section: SkillSection; sort: [number, number, string] }>();
  for (const skill of skills) {
    const held = sections.get(skill.subjectId) ?? {
      section: { subjectId: skill.subjectId, subjectName: skill.subject.name, skills: [] },
      sort: [levelOrder.get(skill.subjectId) ?? 0, skill.subject.order, skill.subject.name] as [number, number, string],
    };
    held.section.skills.push({ id: skill.id, name: skill.name });
    sections.set(skill.subjectId, held);
  }
  return [...sections.values()]
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.sort[2].localeCompare(b.sort[2]))
    .map((held) => held.section);
}

/** Every rating these pupils hold this term, by pupil then skill. One query whatever the class size. */
export async function getRatingsFor(termId: string, studentIds: string[]) {
  const byStudent: Record<string, Record<string, RatingCell>> = {};
  if (studentIds.length === 0) {
    return byStudent;
  }
  const rows = await prisma.skillRating.findMany({
    where: { termId, studentId: { in: studentIds } },
    select: { studentId: true, skillId: true, score: true, grade: true },
  });
  for (const row of rows) {
    (byStudent[row.studentId] ??= {})[row.skillId] = cellOf(row);
  }
  return byStudent;
}

/**
 * The skills half of a card, or null for a level that is marked in the ordinary way.
 *
 * Takes the level's STAGE because the callers already hold it (a report card is loaded with its class
 * and level), so deciding costs no query for the other 95% of cards.
 */
export async function getSkillCard(
  termId: string,
  level: { id: string; stage: Stage },
  studentIds: string[],
): Promise<SkillCardData | null> {
  if (!usesSkillCard(level.stage)) {
    return null;
  }
  const sections = await getSkillSections(level.id);
  const ratings = await getRatingsFor(termId, studentIds);
  return { sections, ratings };
}

/** Levels that report by skills: the choices on both skills screens. */
export async function getSkillLevels() {
  return prisma.level.findMany({
    where: { stage: { in: [...SKILL_CARD_STAGES] } },
    orderBy: { order: "asc" },
    select: { id: true, name: true, code: true },
  });
}

/**
 * The setup screen for one level: every area the level offers, each with its skills and how many
 * children have been rated on each (a rated skill cannot be removed, only renamed).
 */
export async function getSkillSetup(levelId: string) {
  const offered = await prisma.levelSubject.findMany({
    where: { levelId },
    select: { order: true, subject: { select: { id: true, name: true, code: true, order: true } } },
  });
  const skills = await prisma.subjectSkill.findMany({
    where: { levelId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, name: true, subjectId: true },
  });
  const rated =
    skills.length === 0
      ? []
      : await prisma.skillRating.groupBy({
          by: ["skillId"],
          where: { skillId: { in: skills.map((skill) => skill.id) } },
          _count: { _all: true },
        });
  const ratedCount = new Map(rated.map((row) => [row.skillId, row._count._all]));

  const areas = offered
    .map((row) => ({
      sort: [row.order, row.subject.order] as const,
      area: {
        subjectId: row.subject.id,
        name: row.subject.name,
        code: row.subject.code,
        skills: skills
          .filter((skill) => skill.subjectId === row.subject.id)
          .map((skill) => ({ id: skill.id, name: skill.name, rated: ratedCount.get(skill.id) ?? 0 })),
      },
    }))
    .sort((a, b) => a.sort[0] - b.sort[0] || a.sort[1] - b.sort[1] || a.area.name.localeCompare(b.area.name))
    .map((held) => held.area);

  return { areas };
}

/**
 * One class's grid for one area: the pupils down, the area's skills across, every rating already
 * entered, and which pupils' cards are PUBLISHED (their ratings are settled and read-only).
 */
export async function getSkillGrid(termId: string, classGroupId: string, subjectId: string, levelId: string) {
  const skills = await prisma.subjectSkill.findMany({
    where: { levelId, subjectId },
    orderBy: [{ order: "asc" }, { name: "asc" }],
    select: { id: true, name: true },
  });
  const students = await termRoster(termId, classGroupId);
  const studentIds = students.map((student) => student.id);

  const ratings = await getRatingsFor(termId, studentIds);
  const published =
    studentIds.length === 0
      ? []
      : await prisma.termResult.findMany({
          where: { termId, studentId: { in: studentIds }, status: "PUBLISHED" },
          select: { studentId: true },
        });

  return {
    skills,
    students,
    ratings,
    locked: published.map((row) => row.studentId),
  };
}

/** How many pupils in a class have any rating this term, for the results overview. */
export async function countRatedPupils(termId: string, classGroupIds: string[]) {
  if (classGroupIds.length === 0) {
    return new Map<string, number>();
  }
  const results = await prisma.termResult.findMany({
    where: { termId, classGroupId: { in: classGroupIds } },
    select: { classGroupId: true, studentId: true },
  });
  if (results.length === 0) {
    return new Map<string, number>();
  }
  const rated = await prisma.skillRating.groupBy({
    by: ["studentId"],
    where: { termId, studentId: { in: results.map((row) => row.studentId) } },
  });
  const ratedIds = new Set(rated.map((row) => row.studentId));
  const counts = new Map<string, number>();
  for (const row of results) {
    if (ratedIds.has(row.studentId)) {
      counts.set(row.classGroupId, (counts.get(row.classGroupId) ?? 0) + 1);
    }
  }
  return counts;
}
