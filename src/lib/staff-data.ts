import "server-only";

import type { StaffStatus } from "@prisma/client";
import { prisma, type TenantTx } from "@/lib/prisma";

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
      // Not `enteredScores`: a relation count over Score aggregated every school's marks (about 100 ms at ten schools,
      // growing with the data) to feed a hint under a button. The action asks when it is pressed: staffRemovalBlockers.
      _count: { select: { teachingAssignments: true } },
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

/**
 * Why this person cannot be removed from the staff list, if they cannot: they have entered marks (a mark sheet
 * has to keep naming who entered it) or they form-teach a class. Asked when Remove is pressed, not on every view
 * of the page. Each is an existence check scoped to the school, through the `schoolId` index, so it costs about
 * what ONE school holds and never what every school together do.
 *
 * `db` is for scripts that must see a transaction's uncommitted rows; the app never passes it.
 */
export async function staffRemovalBlockers(schoolId: string, staffId: string, db?: TenantTx) {
  const client = (db ?? prisma) as unknown as typeof prisma;
  const scores = await client.score.findFirst({ where: { schoolId, enteredByStaffId: staffId }, select: { id: true } });
  const formClass = await client.classGroup.findFirst({ where: { schoolId, formTeacherId: staffId }, select: { id: true } });
  return { enteredScores: scores !== null, formClasses: formClass !== null };
}
