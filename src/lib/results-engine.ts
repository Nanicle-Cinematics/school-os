import "server-only";

import { Prisma } from "@prisma/client";
import { isExamType } from "@/lib/assessment-templates";
import { sameFields } from "@/lib/row-diff";
import { rosterWhere } from "@/lib/class-roster";
import type { TenantTx } from "@/lib/prisma";

type Tx = TenantTx;

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

export type ScoreInput = {
  rawScore: Prisma.Decimal | null;
  isAbsent: boolean;
  maxScore: Prisma.Decimal;
  weight: Prisma.Decimal;
  isExam: boolean;
};

/**
 * Reduce a student's assessment scores for one subject into the two numbers a
 * Ghanaian report card prints: a class score out of `classWeight` (typically 30
 * or 50) and an exam score out of `examWeight`.
 *
 * Rules, which follow how schools actually mark:
 * - An unmarked score (null, not absent) is EXCLUDED from the weighting, so a
 *   teacher who has entered 2 of 3 tests sees a fair interim score rather than
 *   a student punished for work not yet marked.
 * - Absent IS counted, as zero. That is the point of recording absence.
 * - If no weights were set, items are weighted equally.
 * - Several exam papers average together.
 */
export function computeSubjectScore(
  scores: ScoreInput[],
  classWeight: number,
  examWeight: number,
): { classScore: Prisma.Decimal | null; examScore: Prisma.Decimal | null; total: Prisma.Decimal | null } {
  const usable = scores.filter((s) => s.isAbsent || s.rawScore !== null);
  const classItems = usable.filter((s) => !s.isExam);
  const examItems = usable.filter((s) => s.isExam);

  const percentOf = (score: ScoreInput) => {
    if (score.isAbsent || score.rawScore === null) {
      return ZERO;
    }
    if (score.maxScore.lessThanOrEqualTo(0)) {
      return ZERO;
    }
    return score.rawScore.div(score.maxScore).mul(HUNDRED);
  };

  const weighted = (items: ScoreInput[], outOf: number): Prisma.Decimal | null => {
    if (items.length === 0) {
      return null;
    }
    const totalWeight = items.reduce((acc, item) => acc.add(item.weight), ZERO);

    // No weights configured → equal weighting.
    const percent =
      totalWeight.lessThanOrEqualTo(0)
        ? items.reduce((acc, item) => acc.add(percentOf(item)), ZERO).div(items.length)
        : items
            .reduce((acc, item) => acc.add(percentOf(item).mul(item.weight)), ZERO)
            .div(totalWeight);

    return percent.mul(outOf).div(HUNDRED);
  };

  const classScore = weighted(classItems, classWeight);
  const examScore = weighted(examItems, examWeight);

  if (classScore === null && examScore === null) {
    return { classScore: null, examScore: null, total: null };
  }

  const total = (classScore ?? ZERO).add(examScore ?? ZERO);
  return {
    classScore: classScore === null ? null : round2(classScore),
    examScore: examScore === null ? null : round2(examScore),
    total: round2(total),
  };
}

function round2(value: Prisma.Decimal) {
  return new Prisma.Decimal(value.toFixed(2));
}

export type Band = {
  grade: string;
  minScore: Prisma.Decimal;
  maxScore: Prisma.Decimal;
  points: number;
  remark: string;
  isPass: boolean;
};

export function gradeFor(bands: Band[], score: Prisma.Decimal | null) {
  if (score === null) {
    return null;
  }
  const exact = bands.find(
    (band) => score.greaterThanOrEqualTo(band.minScore) && score.lessThanOrEqualTo(band.maxScore),
  );
  if (exact) {
    return exact;
  }
  // A score between two bands — 79.5 with bands 70–79 and 80–100, which a school
  // can enter and nothing checks — used to get no grade at all. It takes the band
  // it has reached: the highest one whose minimum it clears.
  return (
    bands
      .filter((band) => score.greaterThanOrEqualTo(band.minScore))
      .sort((a, b) => b.minScore.comparedTo(a.minScore))[0] ?? null
  );
}

/**
 * Competition ranking: equal scores share a position and the next position
 * skips (1, 2, 2, 4). Schools read a tie as a genuine tie, and inventing an
 * order between two identical marks is exactly the kind of thing parents
 * challenge at a PTA meeting.
 */
export function rank<T>(items: T[], valueOf: (item: T) => number | null): Map<T, number | null> {
  const positions = new Map<T, number | null>();
  const ranked = items
    .filter((item) => valueOf(item) !== null)
    .sort((a, b) => (valueOf(b) as number) - (valueOf(a) as number));

  let lastValue: number | null = null;
  let lastPosition = 0;

  ranked.forEach((item, index) => {
    const value = valueOf(item) as number;
    if (lastValue !== null && value === lastValue) {
      positions.set(item, lastPosition);
    } else {
      lastPosition = index + 1;
      lastValue = value;
      positions.set(item, lastPosition);
    }
  });

  for (const item of items) {
    if (!positions.has(item)) {
      positions.set(item, null);
    }
  }

  return positions;
}

/** Best-N aggregate, BECE style: lowest total points across N subjects wins. */
export function aggregateOf(points: number[], take: number) {
  if (points.length === 0) {
    return null;
  }
  return [...points]
    .sort((a, b) => a - b)
    .slice(0, take)
    .reduce((sum, value) => sum + value, 0);
}

export type ComputeResult = {
  students: number;
  subjects: number;
  skipped: number;
  /** Only in the third term, where the year's pass mark decides who moves up. */
  promotion: YearPromotion | null;
};

export type YearPromotion = {
  evaluated: number;
  promoted: number;
  repeated: number;
  graduated: number;
  passMark: number;
};

/**
 * The columns a roll-up writes, and so the columns that say whether a stored row already says what it would write.
 * Anything not listed is not this function's to change (the status, the remarks, the register totals).
 */
const SUBJECT_RESULT_FIELDS = [
  "classGroupId",
  "classScore",
  "examScore",
  "totalScore",
  "gradingScaleId",
  "grade",
  "points",
  "remark",
  "subjectPosition",
  "subjectSize",
  "teacherId",
] as const;
const TERM_RESULT_FIELDS = [
  "classGroupId",
  "subjectsCount",
  "subjectsOffered",
  "possibleMarks",
  "totalMarks",
  "average",
  "percentage",
  "aggregate",
  "classPosition",
  "classSize",
] as const;

/**
 * Recompute every SubjectResult and TermResult for one class in one term.
 *
 * Results are stored, not derived on read: positions, class size and aggregate
 * must freeze at publish time so a report card reprinted next year shows what
 * it showed then. Re-running before publication is safe and expected.
 */
export async function computeClassResults(
  tx: Tx,
  schoolId: string,
  termId: string,
  classGroupId: string,
): Promise<ComputeResult> {
  const settings = await tx.schoolSettings.findUnique({ where: { schoolId } });
  const classWeight = settings?.classScoreWeight ?? 30;
  const examWeight = settings?.examScoreWeight ?? 70;
  const aggregateSubjects = settings?.aggregateSubjects ?? 6;

  const classGroup = await tx.classGroup.findUniqueOrThrow({
    where: { id: classGroupId },
    include: {
      level: { include: { levelSubjects: true } },
    },
  });

  const scale =
    (settings?.defaultGradingScaleId
      ? await tx.gradingScale.findUnique({
          where: { id: settings.defaultGradingScaleId },
          include: { bands: true },
        })
      : null) ??
    (await tx.gradingScale.findFirst({ where: { schoolId, isDefault: true }, include: { bands: true } }));

  const bands = (scale?.bands ?? []).map((band) => ({
    grade: band.grade,
    minScore: band.minScore,
    maxScore: band.maxScore,
    points: band.points,
    remark: band.remark,
    isPass: band.isPass,
  }));

  // The year the term belongs to, not every year on record. It decides the
  // roll below, and the teacher name frozen onto SubjectResult — which reprints
  // for as long as the report card exists, so a previous year's teacher must
  // not win that lookup either.
  const term = await tx.term.findUnique({
    where: { id: termId },
    select: { academicYearId: true, sequence: true },
  });

  // The term's own year's roll, not every ACTIVE row in the class: see
  // class-roster.ts for the cohort this used to compute into the wrong term.
  const enrolments = await tx.enrollment.findMany({
    where: { schoolId, ...rosterWhere(term?.academicYearId ?? "", classGroupId) },
    select: { studentId: true },
  });
  const studentIds = enrolments.map((e) => e.studentId);

  if (studentIds.length === 0) {
    return { students: 0, subjects: 0, skipped: 0, promotion: null };
  }

  const assessments = await tx.assessment.findMany({
    where: { schoolId, termId, classGroupId, status: { not: "DRAFT" } },
    include: { scores: true },
  });
  const teaching = await tx.teachingAssignment.findMany({
    where: { schoolId, classGroupId, academicYearId: term?.academicYearId ?? "" },
    select: { subjectId: true, staffId: true },
  });
  const teacherBySubject = new Map(teaching.map((t) => [t.subjectId, t.staffId]));

  const subjectIds = [...new Set(assessments.map((a) => a.subjectId))];
  const aggregateSubjectIds = new Set(
    classGroup.level.levelSubjects.filter((ls) => ls.countsForAggregate).map((ls) => ls.subjectId),
  );

  // subjectId -> studentId -> computed row
  const computed = new Map<
    string,
    Map<string, { classScore: Prisma.Decimal | null; examScore: Prisma.Decimal | null; total: Prisma.Decimal | null }>
  >();

  // One lookup per assessment, so reading a pupil's mark is a map hit rather than a scan of the class's scores.
  const scoreOf = new Map(assessments.map((a) => [a.id, new Map(a.scores.map((s) => [s.studentId, s]))]));

  for (const subjectId of subjectIds) {
    const subjectAssessments = assessments.filter((a) => a.subjectId === subjectId);
    const perStudent = new Map<string, ReturnType<typeof computeSubjectScore>>();

    for (const studentId of studentIds) {
      const inputs: ScoreInput[] = subjectAssessments.map((assessment) => {
        const score = scoreOf.get(assessment.id)?.get(studentId);
        return {
          rawScore: score?.rawScore ?? null,
          isAbsent: score?.isAbsent ?? false,
          maxScore: assessment.maxScore,
          weight: assessment.weight,
          isExam: isExamType(assessment.type),
        };
      });
      perStudent.set(studentId, computeSubjectScore(inputs, classWeight, examWeight));
    }

    computed.set(subjectId, perStudent);
  }

  /**
   * Pupils whose report card is PUBLISHED are settled — the term roll-up below
   * already refuses to touch them, and the subject lines must follow suit. These
   * rows used to be rewritten regardless, so an edited score plus a recompute
   * changed the subject marks a parent was reading while the total and position
   * above them stayed as published: a card that contradicted itself.
   */
  //
  // A pupil whose term was transcribed from paper records (source RECORDS) is
  // settled the same way: there are no marks behind those figures, so a
  // recompute would find nothing and blank the term. See records-engine.ts.
  const publishedHere = new Set(
    (
      await tx.termResult.findMany({
        where: {
          termId,
          studentId: { in: studentIds },
          OR: [{ status: "PUBLISHED" }, { source: "RECORDS" }],
        },
        select: { studentId: true },
      })
    ).map((row) => row.studentId),
  );

  // Persist SubjectResults with per-subject positions.
  //
  // ⚠️ Written as a DIFF, not as one upsert per pupil per subject. A class of 50 over eleven subjects is 550
  // upserts, each its own round trip, all inside one transaction that holds one of the app role's four
  // connections for the whole time, and a teacher saving ONE subject's marks changes about fifty of them. The
  // load test measured a mark-sheet save at about 2.4 CPU-seconds, and a handful at once starving every other
  // request on the instance (P2024). So: read what is there once, write only what differs, and create the
  // new rows in one statement. The rows that result are the same ones the upserts wrote.
  const existingSubjects = new Map(
    (await tx.subjectResult.findMany({ where: { termId, studentId: { in: studentIds } } })).map((row) => [
      `${row.studentId}:${row.subjectId}`,
      row,
    ]),
  );
  const subjectCreates: Prisma.SubjectResultCreateManyInput[] = [];
  const subjectUpdates: { id: string; data: Prisma.SubjectResultCreateManyInput }[] = [];
  const subjectDeletes: string[] = [];
  let skipped = 0;
  for (const subjectId of subjectIds) {
    const perStudent = computed.get(subjectId)!;
    const entries = studentIds.map((studentId) => ({ studentId, ...perStudent.get(studentId)! }));
    const positions = rank(entries, (entry) => (entry.total === null ? null : Number(entry.total)));
    const sized = entries.filter((entry) => entry.total !== null).length;

    for (const entry of entries) {
      if (publishedHere.has(entry.studentId)) {
        continue;
      }
      const had = existingSubjects.get(`${entry.studentId}:${subjectId}`);
      if (entry.total === null) {
        skipped += 1;
        // Remove a stale row rather than leaving last week's number behind.
        if (had && had.source === "COMPUTED") {
          subjectDeletes.push(had.id);
        }
        continue;
      }

      const band = gradeFor(bands, entry.total);
      const data: Prisma.SubjectResultCreateManyInput = {
        schoolId,
        termId,
        studentId: entry.studentId,
        subjectId,
        classGroupId,
        classScore: entry.classScore,
        examScore: entry.examScore,
        totalScore: entry.total,
        gradingScaleId: scale?.id ?? null,
        grade: band?.grade ?? null,
        points: band?.points ?? null,
        remark: band?.remark ?? null,
        subjectPosition: positions.get(entry) ?? null,
        subjectSize: sized,
        teacherId: teacherBySubject.get(subjectId) ?? null,
      };

      if (!had) {
        subjectCreates.push(data);
      } else if (!sameFields(had, data, SUBJECT_RESULT_FIELDS)) {
        subjectUpdates.push({ id: had.id, data });
      }
    }
  }

  if (subjectDeletes.length > 0) {
    await tx.subjectResult.deleteMany({ where: { id: { in: subjectDeletes } } });
  }
  if (subjectCreates.length > 0) {
    const made = await tx.subjectResult.createMany({ data: subjectCreates, skipDuplicates: true });
    if (made.count < subjectCreates.length) {
      // Another roll-up of this class created some of these between our read and now (two teachers saving two
      // subjects at the same moment). Settle every one the way the upsert always did, so the later write wins.
      for (const data of subjectCreates) {
        await tx.subjectResult.upsert({
          where: { termId_studentId_subjectId: { termId, studentId: data.studentId, subjectId: data.subjectId } },
          create: data,
          update: data,
        });
      }
    }
  }
  for (const { id, data } of subjectUpdates) {
    await tx.subjectResult.update({ where: { id }, data });
  }

  /**
   * What the term is marked OUT OF.
   *
   * Every subject is worth 100 — the class and exam weights are defined to make
   * 100 between them — so the denominator is just how many subjects the child
   * sits, times 100. Upper primary offers nine, so the term is out of 900.
   *
   * The universe is the LEVEL's curriculum, not the subjects that happen to
   * have marks in them. That is the whole point: a subject nobody entered
   * scores nothing and pulls the total down, so the hole is visible on the
   * broadsheet instead of being divided away. A school with no curriculum set
   * up falls back to the assessed subjects, which is what this did before.
   *
   * Electives count only for the children who actually sat them — a school
   * offering two and expecting one taken must not mark everybody out of both —
   * and anything assessed off the curriculum counts as well, because a mark
   * that exists has to be worth something.
   */
  const coreSubjectIds = classGroup.level.levelSubjects
    .filter((levelSubject) => !levelSubject.isElective)
    .map((levelSubject) => levelSubject.subjectId);

  // Roll up into TermResults with class positions.
  const rollups = studentIds.map((studentId) => {
    const counted = new Set(coreSubjectIds);
    const aggregatePoints: number[] = [];
    let marked = 0;
    let totalMarks = 0;

    for (const subjectId of subjectIds) {
      const entry = computed.get(subjectId)!.get(studentId)!;
      if (entry.total === null) {
        continue;
      }
      counted.add(subjectId);
      marked += 1;
      totalMarks += Number(entry.total);
      if (aggregateSubjectIds.has(subjectId)) {
        const band = gradeFor(bands, entry.total);
        if (band) {
          aggregatePoints.push(band.points);
        }
      }
    }

    // Nothing marked at all: leave the row empty rather than declaring a child
    // scored 0 of 900 in a term whose marking has not started.
    if (marked === 0 || counted.size === 0) {
      return {
        studentId,
        subjectsCount: 0,
        subjectsOffered: null,
        possibleMarks: null,
        totalMarks: null,
        average: null,
        percentage: null,
        aggregate: aggregateOf(aggregatePoints, aggregateSubjects),
      };
    }

    // Summing 2-decimal scores in floating point leaves noise in the last digits,
    // and two pupils on the same marks then ranked a place apart. Round the sum.
    const exactTotal = Math.round(totalMarks * 100) / 100;
    const possibleMarks = counted.size * 100;
    const percentage = (exactTotal / possibleMarks) * 100;

    return {
      studentId,
      subjectsCount: marked,
      subjectsOffered: counted.size,
      possibleMarks,
      totalMarks: exactTotal,
      // The average is per OFFERED subject, so it agrees with the total above
      // it on the card: 624 of 900 is an average of 69.3, not the 78 that
      // dividing by the eight marked subjects would print beside it.
      average: exactTotal / counted.size,
      percentage,
      aggregate: aggregateOf(aggregatePoints, aggregateSubjects),
    };
  });

  const classPositions = rank(rollups, (row) => row.totalMarks);
  const classSize = rollups.filter((row) => row.totalMarks !== null).length;

  // The same diff for the term totals: one read, then only the pupils whose figures moved.
  const existingTerms = new Map(
    (await tx.termResult.findMany({ where: { termId, studentId: { in: studentIds } } })).map((row) => [row.studentId, row]),
  );
  const termCreates: Prisma.TermResultCreateManyInput[] = [];
  const termUpdates: { id: string; data: Prisma.TermResultCreateManyInput }[] = [];

  for (const row of rollups) {
    const existing = existingTerms.get(row.studentId);

    // Never overwrite a published report card — republishing is an explicit act —
    // nor a term transcribed from paper records, which has no marks to recompute.
    if (existing?.status === "PUBLISHED" || existing?.source === "RECORDS") {
      continue;
    }

    const data: Prisma.TermResultCreateManyInput = {
      schoolId,
      termId,
      studentId: row.studentId,
      classGroupId,
      subjectsCount: row.subjectsCount,
      subjectsOffered: row.subjectsOffered,
      possibleMarks: row.possibleMarks,
      totalMarks: row.totalMarks === null ? null : new Prisma.Decimal(row.totalMarks.toFixed(2)),
      average: row.average === null ? null : new Prisma.Decimal(row.average.toFixed(2)),
      percentage: row.percentage === null ? null : new Prisma.Decimal(row.percentage.toFixed(2)),
      aggregate: row.aggregate,
      classPosition: classPositions.get(row) ?? null,
      classSize,
    };

    if (!existing) {
      termCreates.push({ ...data, status: "DRAFT" as const });
    } else if (!sameFields(existing, data, TERM_RESULT_FIELDS)) {
      termUpdates.push({ id: existing.id, data });
    }
  }

  if (termCreates.length > 0) {
    const made = await tx.termResult.createMany({ data: termCreates, skipDuplicates: true });
    if (made.count < termCreates.length) {
      for (const data of termCreates) {
        const { status: _status, ...update } = data;
        await tx.termResult.upsert({
          where: { termId_studentId: { termId, studentId: data.studentId } },
          create: data,
          update,
        });
      }
    }
  }
  for (const { id, data } of termUpdates) {
    await tx.termResult.update({ where: { id }, data });
  }

  // The third term is the one that decides the year. Doing it here rather than
  // on the promotion screen means the decision is taken from the marks that
  // were just computed, once, and is already on the report card by the time
  // anyone opens it.
  const promotion =
    term?.sequence === 3
      ? await applyYearPromotion(tx, schoolId, termId, classGroupId, term.academicYearId)
      : null;

  return { students: studentIds.length, subjects: subjectIds.length, skipped, promotion };
}

/**
 * Decide, from the whole year, who moves up.
 *
 * The rule is the marks across all three terms against the marks that were
 * available across all three terms — 1861 of 2700 — not the third term alone.
 * A child who fell apart in one term and recovered has not failed the year, and
 * a school that judged them on the term they happened to be ill in would be
 * doing something it could not defend to a parent.
 *
 * Terms with nothing computed simply do not contribute to either side of the
 * fraction, so this is also correct for a school that adopts the system in the
 * second term.
 *
 * The decision is written onto the third term's TermResult, which is where the
 * promotion screen already looks for it — and it is a DEFAULT, not a verdict:
 * the office overrides any row before running the promotion.
 */
export async function applyYearPromotion(
  tx: Tx,
  schoolId: string,
  termId: string,
  classGroupId: string,
  academicYearId: string,
): Promise<YearPromotion> {
  const settings = await tx.schoolSettings.findUnique({ where: { schoolId } });
  const passMark = settings?.promotionPassPercent ?? 45;

  const classGroup = await tx.classGroup.findUniqueOrThrow({
    where: { id: classGroupId },
    select: { level: { select: { order: true } } },
  });

  // No rung above this one means the child is leaving, not being promoted into
  // thin air — JHS 3 graduates.
  const nextLevel = await tx.level.findFirst({
    where: { schoolId, order: { gt: classGroup.level.order } },
    orderBy: { order: "asc" },
    select: { id: true },
  });

  const terms = await tx.term.findMany({
    where: { schoolId, academicYearId },
    select: { id: true },
  });
  const termIds = terms.map((t) => t.id);

  // Never a term transcribed from paper records: that year's promotions were
  // decided long ago, by people, and are already history.
  const thisTerm = await tx.termResult.findMany({
    where: { termId, classGroupId, source: "COMPUTED" },
    select: { studentId: true, status: true },
  });
  const studentIds = thisTerm.map((row) => row.studentId);

  if (studentIds.length === 0) {
    return { evaluated: 0, promoted: 0, repeated: 0, graduated: 0, passMark };
  }

  // Every term of the year for these children, whatever class they sat it in —
  // a child moved between streams in January still carries their first term.
  const yearRows = await tx.termResult.findMany({
    where: { termId: { in: termIds }, studentId: { in: studentIds } },
    select: { studentId: true, totalMarks: true, possibleMarks: true },
  });

  const totals = new Map<string, { marks: number; possible: number }>();
  for (const row of yearRows) {
    if (row.totalMarks === null || !row.possibleMarks) {
      continue;
    }
    const running = totals.get(row.studentId) ?? { marks: 0, possible: 0 };
    running.marks += Number(row.totalMarks);
    running.possible += row.possibleMarks;
    totals.set(row.studentId, running);
  }

  const counts = { evaluated: 0, promoted: 0, repeated: 0, graduated: 0, passMark };

  for (const row of thisTerm) {
    // A published card is settled. Re-deciding it behind the office's back is
    // how a parent ends up holding two different answers.
    if (row.status === "PUBLISHED") {
      continue;
    }
    const total = totals.get(row.studentId);
    if (!total || total.possible === 0) {
      continue;
    }

    const percent = (total.marks / total.possible) * 100;
    const promotionStatus =
      percent < passMark ? "REPEATED" : nextLevel ? "PROMOTED" : "GRADUATED";

    await tx.termResult.update({
      where: { termId_studentId: { termId, studentId: row.studentId } },
      data: { promotionStatus },
    });

    counts.evaluated += 1;
    if (promotionStatus === "REPEATED") counts.repeated += 1;
    else if (promotionStatus === "GRADUATED") counts.graduated += 1;
    else counts.promoted += 1;
  }

  return counts;
}

/** 1st, 2nd, 3rd — printed on every report card. */
export function ordinal(position: number | null | undefined) {
  if (position === null || position === undefined) {
    return "—";
  }
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) {
    return `${position}th`;
  }
  switch (position % 10) {
    case 1:
      return `${position}st`;
    case 2:
      return `${position}nd`;
    case 3:
      return `${position}rd`;
    default:
      return `${position}th`;
  }
}
