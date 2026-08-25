import "server-only";

import { prisma } from "@/lib/prisma";

/** Levels a subject is offered at, ordered down the ladder rather than by id. */
function orderLevels<T extends { level: { order: number } }>(rows: T[]) {
  return [...rows].sort((a, b) => a.level.order - b.level.order);
}

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export async function getSubjectList() {
  const subjects = await prisma.subject.findMany({
    orderBy: [{ order: "asc" }, { name: "asc" }],
    include: {
      levelSubjects: {
        include: { level: { select: { id: true, code: true, name: true, order: true } } },
      },
      _count: { select: { teachingAssignments: true, assessments: true } },
    },
  });
  const levelCount = await prisma.level.count();

  return {
    levelCount,
    subjects: subjects.map((subject) => ({
      ...subject,
      levelSubjects: orderLevels(subject.levelSubjects),
    })),
  };
}

export async function getSubject(id: string) {
  const subject = await prisma.subject.findUnique({
    where: { id },
    include: {
      levelSubjects: {
        include: { level: { select: { id: true, code: true, name: true, order: true } } },
      },
      _count: { select: { assessments: true, subjectResults: true, teachingAssignments: true } },
    },
  });

  if (!subject) {
    return null;
  }

  const levels = await prisma.level.findMany({ orderBy: { order: "asc" } });

  // One row per level, whether or not the subject is offered there — the editor
  // is a matrix, so the "not offered" levels have to be present as blanks.
  const offering = new Map(subject.levelSubjects.map((row) => [row.levelId, row]));

  return {
    subject,
    rows: levels.map((level) => {
      const row = offering.get(level.id);
      return {
        level,
        offered: Boolean(row),
        isElective: row?.isElective ?? !subject.isCore,
        countsForAggregate: row?.countsForAggregate ?? true,
      };
    }),
  };
}
