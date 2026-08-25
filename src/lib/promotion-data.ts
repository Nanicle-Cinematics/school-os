import "server-only";

import type { PromotionStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export type Decision = "PROMOTE" | "REPEAT" | "GRADUATE" | "HOLD";

export type Move = { studentId: string; decision: Decision; destinationId: string | null };

export type ClassPlan = {
  classGroup: { id: string; name: string; levelName: string; order: number };
  destinationLabel: string | null;
  /** Needs somewhere to go but the level above has no classes. */
  blocked: boolean;
  counts: { promote: number; repeat: number; graduate: number; alreadyPlaced: number };
  moves: Move[];
};

export async function getPromotionSetup() {
  const years = await prisma.academicYear.findMany({
    orderBy: { startDate: "desc" },
    select: { id: true, name: true, isCurrent: true },
  });

  const classGroups = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      level: { select: { id: true, name: true, order: true } },
    },
  });

  return { years, classGroups };
}

/**
 * Work out where each child in a class should land next year.
 *
 * The suggestion is only a default: a form teacher overrides per student, which
 * is the whole point — a class of 40 always has a handful repeating.
 */
export async function getPromotionPlan(
  classGroupId: string,
  sourceYearId: string,
  targetYearId: string,
) {
  const classGroup = await prisma.classGroup.findUnique({
    where: { id: classGroupId },
    select: { id: true, name: true, level: { select: { id: true, name: true, order: true } } },
  });
  if (!classGroup) {
    return null;
  }

  const sourceYear = await prisma.academicYear.findUnique({
    where: { id: sourceYearId },
    select: { id: true, name: true },
  });
  const targetYear = await prisma.academicYear.findUnique({
    where: { id: targetYearId },
    select: { id: true, name: true },
  });
  if (!sourceYear || !targetYear) {
    return null;
  }

  // The next rung is simply the next `order` up. A school with a gap in its
  // ladder (no JHS, say) still promotes correctly because nothing assumes +1.
  const nextLevel = await prisma.level.findFirst({
    where: { order: { gt: classGroup.level.order } },
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true },
  });

  const destinationClasses = nextLevel
    ? await prisma.classGroup.findMany({
        where: { levelId: nextLevel.id },
        orderBy: { name: "asc" },
        select: { id: true, name: true, level: { select: { name: true } } },
      })
    : [];

  const repeatClasses = await prisma.classGroup.findMany({
    where: { levelId: classGroup.level.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true, level: { select: { name: true } } },
  });

  // Keeping the stream: Basic 5 Gold → Basic 6 Gold, when Gold exists up there.
  const sameStream = destinationClasses.find((group) => group.name === classGroup.name);
  const defaultDestination = sameStream?.id ?? destinationClasses[0]?.id ?? null;

  const roster = await prisma.enrollment.findMany({
    where: { classGroupId, academicYearId: sourceYearId },
    include: {
      student: {
        select: { id: true, admissionNo: true, firstName: true, lastName: true, status: true },
      },
    },
    orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
  });

  const studentIds = roster.map((row) => row.studentId);

  // What the class teacher already decided on the last report card, if results
  // were published — a promotion screen that ignores that would ask twice.
  const termResults = studentIds.length
    ? await prisma.termResult.findMany({
        where: {
          studentId: { in: studentIds },
          term: { academicYearId: sourceYearId },
          promotionStatus: { not: "PENDING" },
        },
        orderBy: { term: { sequence: "desc" } },
        select: { studentId: true, promotionStatus: true },
      })
    : [];
  const decided = new Map<string, PromotionStatus>();
  for (const result of termResults) {
    if (!decided.has(result.studentId)) {
      decided.set(result.studentId, result.promotionStatus);
    }
  }

  // Anyone already placed in the target year — a second run must not look like
  // a fresh one.
  const existing = studentIds.length
    ? await prisma.enrollment.findMany({
        where: { studentId: { in: studentIds }, academicYearId: targetYearId },
        select: {
          studentId: true,
          classGroup: { select: { name: true, level: { select: { name: true } } } },
        },
      })
    : [];
  const placed = new Map(
    existing.map((row) => [
      row.studentId,
      `${row.classGroup.level.name} ${row.classGroup.name}`,
    ]),
  );

  const rows = roster.map((enrollment) => {
    const fromResult = decided.get(enrollment.studentId);
    let decision: Decision = nextLevel ? "PROMOTE" : "GRADUATE";
    if (fromResult === "REPEATED") {
      decision = "REPEAT";
    } else if (fromResult === "GRADUATED") {
      decision = "GRADUATE";
    }

    return {
      enrollmentId: enrollment.id,
      student: enrollment.student,
      enrollmentStatus: enrollment.status,
      suggestion: decision,
      fromReportCard: fromResult ?? null,
      destinationId: decision === "REPEAT" ? classGroup.id : defaultDestination,
      alreadyPlacedIn: placed.get(enrollment.studentId) ?? null,
    };
  });

  return {
    classGroup,
    sourceYear,
    targetYear,
    nextLevel,
    destinationClasses,
    repeatClasses,
    rows,
  };
}

/**
 * The same plan, for every class at once.
 *
 * Deliberately NOT getPromotionPlan in a loop: that is seven queries per class,
 * and on this connection (limit 1) a twelve-class school would spend half a
 * minute rendering. This reads the whole year in five queries and does the
 * matching in memory, so it costs the same whether the school has three classes
 * or thirty.
 */
export async function getWholeSchoolPlan(sourceYearId: string, targetYearId: string) {
  const levels = await prisma.level.findMany({
    orderBy: { order: "asc" },
    select: { id: true, name: true, order: true },
  });

  const classGroups = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    select: { id: true, name: true, levelId: true },
  });

  const roster = await prisma.enrollment.findMany({
    where: { academicYearId: sourceYearId, status: "ACTIVE" },
    select: { studentId: true, classGroupId: true },
  });

  const termResults = await prisma.termResult.findMany({
    where: { term: { academicYearId: sourceYearId }, promotionStatus: { not: "PENDING" } },
    orderBy: { term: { sequence: "desc" } },
    select: { studentId: true, promotionStatus: true },
  });

  const alreadyPlaced = await prisma.enrollment.findMany({
    where: { academicYearId: targetYearId },
    select: { studentId: true },
  });

  const levelById = new Map(levels.map((level) => [level.id, level]));
  const classesByLevel = new Map<string, typeof classGroups>();
  for (const group of classGroups) {
    classesByLevel.set(group.levelId, [...(classesByLevel.get(group.levelId) ?? []), group]);
  }

  const decided = new Map<string, string>();
  for (const result of termResults) {
    if (!decided.has(result.studentId)) {
      decided.set(result.studentId, result.promotionStatus);
    }
  }
  const placed = new Set(alreadyPlaced.map((row) => row.studentId));

  const rosterByClass = new Map<string, string[]>();
  for (const row of roster) {
    rosterByClass.set(row.classGroupId, [...(rosterByClass.get(row.classGroupId) ?? []), row.studentId]);
  }

  const plans: ClassPlan[] = [];

  for (const group of classGroups) {
    const students = rosterByClass.get(group.id) ?? [];
    if (students.length === 0) {
      continue;
    }

    const level = levelById.get(group.levelId);
    const nextLevel = levels.find((candidate) => candidate.order > (level?.order ?? 0));
    const destinations = nextLevel ? (classesByLevel.get(nextLevel.id) ?? []) : [];
    const sameStream = destinations.find((candidate) => candidate.name === group.name);
    const destination = sameStream ?? destinations[0] ?? null;

    const counts = { promote: 0, repeat: 0, graduate: 0, alreadyPlaced: 0 };
    const moves: Move[] = [];

    for (const studentId of students) {
      const said = decided.get(studentId);
      let decision: Decision = nextLevel ? "PROMOTE" : "GRADUATE";
      if (said === "REPEATED") {
        decision = "REPEAT";
      } else if (said === "GRADUATED") {
        decision = "GRADUATE";
      }

      if (decision === "PROMOTE" && !destination) {
        // Nowhere to go: left for the office to resolve rather than silently
        // graduated or silently skipped.
        continue;
      }

      moves.push({
        studentId,
        decision,
        destinationId: decision === "REPEAT" ? group.id : decision === "PROMOTE" ? destination!.id : null,
      });

      if (placed.has(studentId)) {
        counts.alreadyPlaced += 1;
      }
      if (decision === "PROMOTE") counts.promote += 1;
      else if (decision === "REPEAT") counts.repeat += 1;
      else counts.graduate += 1;
    }

    plans.push({
      classGroup: {
        id: group.id,
        name: group.name,
        levelName: level?.name ?? "",
        order: level?.order ?? 0,
      },
      destinationLabel: destination
        ? `${levelById.get(destination.levelId)?.name ?? ""} ${destination.name}`
        : nextLevel
          ? null
          : "leaves the school",
      blocked: Boolean(nextLevel) && !destination,
      counts,
      moves,
    });
  }

  return { plans };
}
