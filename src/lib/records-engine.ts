import "server-only";

import { Prisma } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { rosterWhere } from "@/lib/class-roster";
import { aggregateOf, rank, type Band } from "@/lib/results-engine";

type Tx = TenantTx;

/**
 * Results from the school's PAPER records, for the years before it used School OS.
 *
 * GES expects a JHS 3 candidate's record to run back to JHS 1. A school that
 * adopts the system in a pupil's final year has those two earlier years only on
 * paper, and nothing here could hold them: a mark sheet is built from the
 * components marked in School OS, and there are no components behind a 2024
 * end-of-term total. So these are entered as the TERM figures the paper holds —
 * class score and exam score, or a single total — straight into SubjectResult,
 * marked `source: RECORDS`, and rolled up into a TermResult the same way the
 * engine rolls up its own.
 *
 * Three rules keep them apart from computed results, each enforced where the
 * computed path would otherwise reach them:
 *
 * - only a year that ENDED before the current one starts takes records — the
 *   current year is marked in School OS, and a record there would sit beside a
 *   mark sheet claiming the same term;
 * - `computeClassResults` treats a pupil with a RECORDS TermResult as settled,
 *   because a recompute would find no marks and blank the term;
 * - publishing never reaches them, so they are never shown to a parent or
 *   texted about. They are the office's records, not a report card.
 */

export type EarlierYear = { id: string; name: string; startDate: Date; endDate: Date };

/** A year takes records only if it ended before the current one began. */
export function isEarlierYear(
  year: { endDate: Date },
  current: { startDate: Date } | null,
): boolean {
  return Boolean(current) && year.endDate < (current as { startDate: Date }).startDate;
}

/**
 * How many years before the current one this is, counted in academic years the
 * school has on record — 2025/26 is one back from 2026/27, 2024/25 two. Counting
 * rows rather than calendar years keeps a gap year from shifting every pupil a
 * class down.
 */
export function yearsBack(
  year: { startDate: Date },
  current: { startDate: Date },
  all: { startDate: Date }[],
): number {
  return all.filter((y) => y.startDate >= year.startDate && y.startDate < current.startDate).length;
}

type ClassOption = { id: string; name: string; level: { name: string; order: number } };

/** "Basic 5 Gold" and "Gold" are the same stream; compare what is left of the name. */
function streamOf(name: string, levelName: string): string {
  const lower = name.trim().toLowerCase();
  const level = levelName.trim().toLowerCase();
  const rest = lower.startsWith(level) ? lower.slice(level.length) : lower;
  return rest.trim();
}

/**
 * The class a pupil most likely sat in `back` years ago: the level `back` rungs
 * down, in the same stream. A guess the office corrects — a repeater or a
 * stream change is exactly what this cannot know — so it is only ever a default
 * in a form, never written on its own.
 *
 * Falls back to the only class at that level when there is one, and to nothing
 * when the stream cannot be told; a wrong class already selected is worse than
 * an empty one the office has to choose.
 */
export function proposeEarlierClass(
  current: ClassOption,
  back: number,
  classes: ClassOption[],
): string | null {
  const targetOrder = current.level.order - back;
  const atLevel = classes.filter((c) => c.level.order === targetOrder);
  if (atLevel.length === 0) {
    return null;
  }
  const stream = streamOf(current.name, current.level.name);
  const sameStream = atLevel.find((c) => streamOf(c.name, c.level.name) === stream);
  if (sameStream) {
    return sameStream.id;
  }
  return atLevel.length === 1 ? atLevel[0].id : null;
}

/**
 * One typed mark, checked against what it can be out of.
 *
 * Blank is "no record" — not zero. A paper record with a hole in it must stay a
 * hole, exactly as a subject nobody marked invents no score.
 */
export function parseRecordedMark(
  raw: string,
  max: number,
): { ok: true; value: number | null } | { ok: false; reason: string } {
  const text = raw.trim();
  if (text === "") {
    return { ok: true, value: null };
  }
  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    return { ok: false, reason: `"${text}" is not a mark — use a number such as 24 or 24.5` };
  }
  const value = Number(text);
  if (value > max) {
    return { ok: false, reason: `${text} is more than the ${max} it is out of` };
  }
  return { ok: true, value };
}

export async function loadGradingBands(tx: Tx, schoolId: string) {
  const settings = await tx.schoolSettings.findUnique({ where: { schoolId } });
  const scale =
    (settings?.defaultGradingScaleId
      ? await tx.gradingScale.findUnique({
          where: { id: settings.defaultGradingScaleId },
          include: { bands: true },
        })
      : null) ??
    (await tx.gradingScale.findFirst({ where: { schoolId, isDefault: true }, include: { bands: true } }));

  const bands: Band[] = (scale?.bands ?? []).map((band) => ({
    grade: band.grade,
    minScore: band.minScore,
    maxScore: band.maxScore,
    points: band.points,
    remark: band.remark,
    isPass: band.isPass,
  }));
  return { settings, scaleId: scale?.id ?? null, bands };
}

/**
 * Re-derive positions and the term roll-up for a class's RECORDS in one term.
 *
 * Subject positions are refreshed only for `subjectId` — the one sheet just
 * saved — because a save changes nothing else, and every write is a round trip
 * to Frankfurt. The term totals and class positions are refreshed for the whole
 * roll, because one subject's change moves both.
 *
 * Pupils with a computed term in this term are left alone: they were marked in
 * School OS, and a record must not overwrite what the engine owns.
 */
export async function rollUpRecords(
  tx: Tx,
  schoolId: string,
  termId: string,
  classGroupId: string,
  subjectId: string,
): Promise<{ pupils: number }> {
  const term = await tx.term.findUniqueOrThrow({ where: { id: termId }, select: { academicYearId: true } });
  const settings = await tx.schoolSettings.findUnique({ where: { schoolId } });
  const aggregateSubjects = settings?.aggregateSubjects ?? 6;

  const classGroup = await tx.classGroup.findUniqueOrThrow({
    where: { id: classGroupId },
    select: { level: { select: { levelSubjects: true } } },
  });

  const roll = await tx.enrollment.findMany({
    where: { schoolId, ...rosterWhere(term.academicYearId, classGroupId) },
    select: { studentId: true },
  });
  const computedHere = new Set(
    (
      await tx.termResult.findMany({
        // A COMPUTED row with no total is only a shell — the remarks screen
        // creates one to hold a conduct line — and the records take it over.
        where: {
          termId,
          studentId: { in: roll.map((r) => r.studentId) },
          source: "COMPUTED",
          OR: [{ totalMarks: { not: null } }, { status: "PUBLISHED" }],
        },
        select: { studentId: true },
      })
    ).map((r) => r.studentId),
  );
  const pupils = roll.map((r) => r.studentId).filter((id) => !computedHere.has(id));

  const rows = await tx.subjectResult.findMany({
    where: { termId, studentId: { in: pupils }, source: "RECORDS" },
    select: {
      id: true,
      studentId: true,
      subjectId: true,
      totalScore: true,
      points: true,
      subjectPosition: true,
      subjectSize: true,
    },
  });

  // Subject positions, for the sheet that was saved.
  const sheet = rows.filter((row) => row.subjectId === subjectId);
  const subjectPositions = rank(sheet, (row) => (row.totalScore === null ? null : Number(row.totalScore)));
  const sized = sheet.filter((row) => row.totalScore !== null).length;
  for (const row of sheet) {
    const position = subjectPositions.get(row) ?? null;
    if (row.subjectPosition !== position || row.subjectSize !== sized) {
      await tx.subjectResult.update({
        where: { id: row.id },
        data: { subjectPosition: position, subjectSize: sized },
      });
    }
  }

  // Term roll-up, the same arithmetic as computeClassResults: out of the
  // level's curriculum, so a subject with no record pulls the total down rather
  // than being divided away.
  const coreSubjectIds = classGroup.level.levelSubjects.filter((ls) => !ls.isElective).map((ls) => ls.subjectId);
  const aggregateSubjectIds = new Set(
    classGroup.level.levelSubjects.filter((ls) => ls.countsForAggregate).map((ls) => ls.subjectId),
  );

  const rollups = pupils.map((studentId) => {
    const own = rows.filter((row) => row.studentId === studentId && row.totalScore !== null);
    if (own.length === 0) {
      return { studentId, totalMarks: null as number | null, possibleMarks: 0, counted: 0, marked: 0, aggregate: null as number | null };
    }
    const counted = new Set(coreSubjectIds);
    let total = 0;
    const points: number[] = [];
    for (const row of own) {
      counted.add(row.subjectId);
      total += Number(row.totalScore);
      if (aggregateSubjectIds.has(row.subjectId) && row.points !== null) {
        points.push(row.points);
      }
    }
    return {
      studentId,
      totalMarks: Math.round(total * 100) / 100,
      possibleMarks: counted.size * 100,
      counted: counted.size,
      marked: own.length,
      aggregate: aggregateOf(points, aggregateSubjects),
    };
  });

  const classPositions = rank(rollups, (row) => row.totalMarks);
  const classSize = rollups.filter((row) => row.totalMarks !== null).length;

  for (const row of rollups) {
    if (row.totalMarks === null) {
      // Every record for this pupil was cleared: so is their term.
      await tx.termResult.deleteMany({ where: { termId, studentId: row.studentId, source: "RECORDS" } });
      continue;
    }
    const data = {
      schoolId,
      termId,
      studentId: row.studentId,
      classGroupId,
      subjectsCount: row.marked,
      subjectsOffered: row.counted,
      possibleMarks: row.possibleMarks,
      totalMarks: new Prisma.Decimal(row.totalMarks.toFixed(2)),
      average: new Prisma.Decimal((row.totalMarks / row.counted).toFixed(2)),
      percentage: new Prisma.Decimal(((row.totalMarks / row.possibleMarks) * 100).toFixed(2)),
      aggregate: row.aggregate,
      classPosition: classPositions.get(row) ?? null,
      classSize,
    };
    // APPROVED, not DRAFT: these are a finished year's settled figures, and
    // publishing (the only step past APPROVED) never selects a RECORDS row.
    await tx.termResult.upsert({
      where: { termId_studentId: { termId, studentId: row.studentId } },
      create: { ...data, source: "RECORDS", status: "APPROVED" },
      update: { ...data, source: "RECORDS", status: "APPROVED" },
    });
  }

  return { pupils: pupils.length };
}

