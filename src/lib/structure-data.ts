import "server-only";

import type { Stage } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

/** The Ghanaian ladder, in the order a school climbs it. */
export const STAGES: { value: Stage; label: string }[] = [
  { value: "CRECHE", label: "Creche" },
  { value: "NURSERY", label: "Nursery" },
  { value: "KINDERGARTEN", label: "Kindergarten" },
  { value: "PRIMARY", label: "Primary" },
  { value: "JHS", label: "JHS" },
  { value: "SHS", label: "SHS" },
];

export async function getStructure() {
  const levels = await prisma.level.findMany({
    orderBy: { order: "asc" },
    include: {
      _count: { select: { classGroups: true, levelSubjects: true, feeStructures: true } },
    },
  });

  const houses = await prisma.house.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { students: true } } },
  });

  const programmes = await prisma.programme.findMany({
    orderBy: { name: "asc" },
    include: { _count: { select: { students: true } } },
  });

  return { levels, houses, programmes };
}
