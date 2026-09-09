import "server-only";

import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

export async function getGuardianList(query: string) {
  const where = {
    deletedAt: null,
    ...(query
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" as const } },
            { lastName: { contains: query, mode: "insensitive" as const } },
            { phone: { contains: query } },
            { altPhone: { contains: query } },
          ],
        }
      : {}),
  };

  const guardians = await prisma.guardian.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 100,
    include: {
      students: {
        include: {
          student: { select: { id: true, firstName: true, lastName: true, admissionNo: true } },
        },
      },
    },
  });

  const total = await prisma.guardian.count({ where: { deletedAt: null } });

  return { guardians, total };
}

export async function getGuardian(id: string) {
  const guardian = await prisma.guardian.findUnique({
    where: { id },
    include: {
      students: {
        include: {
          student: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              admissionNo: true,
              status: true,
              currentClassGroup: {
                select: { name: true, level: { select: { name: true } } },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      },
      _count: { select: { payments: true, messages: true } },
    },
  });

  if (!guardian || guardian.deletedAt) {
    return null;
  }

  const linked = new Set(guardian.students.map((row) => row.studentId));

  // Candidates for linking: on-roll students not already tied to this guardian.
  const students = await prisma.student.findMany({
    where: { deletedAt: null, status: { in: ["ACTIVE", "ADMITTED"] }, id: { notIn: [...linked] } },
    select: { id: true, firstName: true, lastName: true, admissionNo: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 500,
  });

  // Whether this guardian already has a parent-portal sign-in. Counted rather
  // than included on the guardian, because a Membership belongs to the login
  // side of the model and dragging it into every guardian read would widen a
  // query used by the list screen too.
  const logins = await prisma.membership.count({ where: { guardianId: id } });

  return { guardian, students, hasLogin: logins > 0 };
}
