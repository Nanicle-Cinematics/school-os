import "server-only";

import type { StaffStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

/** Everyone off the payroll: hidden by default, but still findable. */
const FORMER: StaffStatus[] = ["RESIGNED", "RETIRED"];

export async function getStaffList(query: string, includeFormer: boolean) {
  const where = {
    deletedAt: null,
    ...(includeFormer ? {} : { status: { notIn: FORMER } }),
    ...(query
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" as const } },
            { lastName: { contains: query, mode: "insensitive" as const } },
            { staffNo: { contains: query, mode: "insensitive" as const } },
            { designation: { contains: query, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  const staff = await prisma.staff.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 200,
    include: {
      formClasses: { select: { id: true, name: true, level: { select: { name: true } } } },
      _count: { select: { teachingAssignments: true } },
    },
  });

  const total = await prisma.staff.count({
    where: { deletedAt: null, status: { notIn: FORMER } },
  });

  return { staff, total };
}

export async function getStaffMember(id: string) {
  const staff = await prisma.staff.findUnique({
    where: { id },
    include: {
      formClasses: { select: { id: true, name: true, level: { select: { name: true } } } },
      memberships: { select: { id: true, role: true, status: true } },
      _count: { select: { enteredScores: true, teachingAssignments: true } },
    },
  });

  if (!staff || staff.deletedAt) {
    return null;
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });

  const assignments = year
    ? await prisma.teachingAssignment.findMany({
        where: { staffId: id, academicYearId: year.id },
        include: {
          subject: { select: { id: true, name: true, code: true } },
          classGroup: {
            select: { id: true, name: true, level: { select: { name: true, order: true } } },
          },
        },
        orderBy: [{ classGroup: { level: { order: "asc" } } }, { subject: { order: "asc" } }],
      })
    : [];

  const subjects = await prisma.subject.findMany({
    select: { id: true, name: true, code: true },
    orderBy: [{ order: "asc" }, { name: "asc" }],
  });

  const classGroups = await prisma.classGroup.findMany({
    select: { id: true, name: true, level: { select: { name: true, order: true } } },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
  });

  return { staff, year, assignments, subjects, classGroups };
}
