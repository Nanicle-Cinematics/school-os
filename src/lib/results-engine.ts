import "server-only";

import { Prisma } from "@prisma/client";
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
  return (
    bands.find(
      (band) => score.greaterThanOrEqualTo(band.minScore) && score.lessThanOrEqualTo(band.maxScore),
    ) ?? null
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
};

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

  const enrolments = await tx.enrollment.findMany({
    where: { schoolId, classGroupId, status: "ACTIVE" },
    include: { student: { select: { id: true } } },
  });
  const studentIds = enrolments.map((e) => e.studentId);

  if (studentIds.length === 0) {
    return { students: 0, subjects: 0, skipped: 0 };
  }

  const assessments = await tx.assessment.findMany({
    where: { schoolId, termId, classGroupId, status: { not: "DRAFT" } },
    include: { scores: true },
  });

  const teaching = await tx.teachingAssignment.findMany({
    where: { schoolId, classGroupId },
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

  for (const subjectId of subjectIds) {
    const subjectAssessments = assessments.filter((a) => a.subjectId === subjectId);
    const perStudent = new Map<string, ReturnType<typeof computeSubjectScore>>();

    for (const studentId of studentIds) {
      const inputs: ScoreInput[] = subjectAssessments.map((assessment) => {
        const score = assessment.scores.find((s) => s.studentId === studentId);
        return {
          rawScore: score?.rawScore ?? null,
          isAbsent: score?.isAbsent ?? false,
          maxScore: assessment.maxScore,
          weight: assessment.weight,
          isExam: assessment.type === "END_OF_TERM_EXAM" || assessment.type === "MIDTERM_EXAM",
        };
      });
      perStudent.set(studentId, computeSubjectScore(inputs, classWeight, examWeight));
    }

    computed.set(subjectId, perStudent);
  }

  // Persist SubjectResults with per-subject positions.
  let skipped = 0;
  for (const subjectId of subjectIds) {
    const perStudent = computed.get(subjectId)!;
    const entries = studentIds.map((studentId) => ({ studentId, ...perStudent.get(studentId)! }));
    const positions = rank(entries, (entry) => (entry.total === null ? null : Number(entry.total)));
    const sized = entries.filter((entry) => entry.total !== null).length;

    for (const entry of entries) {
      if (entry.total === null) {
        skipped += 1;
        // Remove a stale row rather than leaving last week's number behind.
        await tx.subjectResult.deleteMany({ where: { termId, studentId: entry.studentId, subjectId } });
        continue;
      }

      const band = gradeFor(bands, entry.total);
      const data = {
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

      await tx.subjectResult.upsert({
        where: { termId_studentId_subjectId: { termId, studentId: entry.studentId, subjectId } },
        create: data,
        update: data,
      });
    }
  }

  // Roll up into TermResults with class positions.
  const rollups = studentIds.map((studentId) => {
    const subjectTotals: number[] = [];
    const aggregatePoints: number[] = [];

    for (const subjectId of subjectIds) {
      const entry = computed.get(subjectId)!.get(studentId)!;
      if (entry.total === null) {
        continue;
      }
      subjectTotals.push(Number(entry.total));
      if (aggregateSubjectIds.has(subjectId)) {
        const band = gradeFor(bands, entry.total);
        if (band) {
          aggregatePoints.push(band.points);
        }
      }
    }

    const totalMarks = subjectTotals.reduce((sum, value) => sum + value, 0);
    return {
      studentId,
      subjectsCount: subjectTotals.length,
      totalMarks: subjectTotals.length > 0 ? totalMarks : null,
      average: subjectTotals.length > 0 ? totalMarks / subjectTotals.length : null,
      aggregate: aggregateOf(aggregatePoints, aggregateSubjects),
    };
  });

  const classPositions = rank(rollups, (row) => row.totalMarks);
  const classSize = rollups.filter((row) => row.totalMarks !== null).length;

  for (const row of rollups) {
    const existing = await tx.termResult.findUnique({
      where: { termId_studentId: { termId, studentId: row.studentId } },
    });

    // Never overwrite a published report card — republishing is an explicit act.
    if (existing?.status === "PUBLISHED") {
      continue;
    }

    const data = {
      schoolId,
      termId,
      studentId: row.studentId,
      classGroupId,
      subjectsCount: row.subjectsCount,
      totalMarks: row.totalMarks === null ? null : new Prisma.Decimal(row.totalMarks.toFixed(2)),
      average: row.average === null ? null : new Prisma.Decimal(row.average.toFixed(2)),
      aggregate: row.aggregate,
      classPosition: classPositions.get(row) ?? null,
      classSize,
    };

    await tx.termResult.upsert({
      where: { termId_studentId: { termId, studentId: row.studentId } },
      create: { ...data, status: "DRAFT" as const },
      update: data,
    });
  }

  return { students: studentIds.length, subjects: subjectIds.length, skipped };
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
