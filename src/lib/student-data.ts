import "server-only";

import type { Prisma, StudentStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { netOutstanding } from "@/lib/invoice-engine";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

const PAGE_SIZE = 50;

export type StudentFilters = {
  q?: string;
  classGroupId?: string;
  status?: string;
  page?: number;
};

export async function getStudentList(filters: StudentFilters) {
  const query = filters.q?.trim() ?? "";
  const page = Math.max(1, filters.page ?? 1);

  const where: Prisma.StudentWhereInput = {
    deletedAt: null,
    ...(filters.classGroupId ? { currentClassGroupId: filters.classGroupId } : {}),
    ...(filters.status ? { status: filters.status as StudentStatus } : {}),
    ...(query
      ? {
          OR: [
            { firstName: { contains: query, mode: "insensitive" } },
            { lastName: { contains: query, mode: "insensitive" } },
            { admissionNo: { contains: query, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const matching = await prisma.student.count({ where });

  const students = await prisma.student.findMany({
    where,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    include: {
      currentClassGroup: { select: { name: true, level: { select: { name: true, order: true } } } },
      house: { select: { name: true } },
      guardians: {
        where: { isPrimary: true },
        take: 1,
        include: { guardian: { select: { firstName: true, lastName: true, phone: true } } },
      },
    },
  });

  const total = await prisma.student.count({ where: { deletedAt: null } });

  return {
    students,
    matching,
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(matching / PAGE_SIZE)),
  };
}

/** Classes, houses and programmes — everything the admission form has to offer. */
export async function getStudentFormOptions() {
  const classGroups = await prisma.classGroup.findMany({
    select: { id: true, name: true, level: { select: { name: true, order: true } } },
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
  });
  const houses = await prisma.house.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  const programmes = await prisma.programme.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return { classGroups, houses, programmes };
}

export async function getStudent(id: string) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      currentClassGroup: { select: { id: true, name: true, level: { select: { name: true } } } },
      house: { select: { id: true, name: true } },
      programme: { select: { id: true, name: true } },
      guardians: {
        include: {
          guardian: {
            select: { id: true, firstName: true, lastName: true, phone: true, email: true },
          },
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!student || student.deletedAt) {
    return null;
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });

  const enrollments = await prisma.enrollment.findMany({
    where: { studentId: id },
    include: {
      academicYear: { select: { id: true, name: true, isCurrent: true } },
      classGroup: { select: { id: true, name: true, level: { select: { name: true } } } },
    },
    orderBy: { academicYear: { startDate: "desc" } },
  });

  const invoices = await prisma.invoice.findMany({
    where: { studentId: id, status: { not: "CANCELLED" } },
    include: { term: { select: { name: true, sequence: true, academicYear: { select: { name: true } } } } },
    orderBy: { issueDate: "desc" },
    take: 12,
  });

  const termResults = await prisma.termResult.findMany({
    where: { studentId: id },
    include: {
      term: { select: { id: true, name: true, sequence: true, academicYear: { select: { name: true } } } },
    },
    orderBy: { createdAt: "desc" },
    take: 6,
  });

  // ⚠️ NOT a sum of invoice balances. This spans every term the student has
  // been billed for, and each term's invoice carries the previous term's
  // balance forward — so summing counted old arrears twice, the same bug PR
  // #82 fixed for the debtor SMS audience and the parent portal (see
  // netOutstanding). This screen reads "across all terms" and renders as an
  // alarm when nonzero, so it needs the same fix.
  const payments = await prisma.payment.findMany({
    where: { studentId: id, reversedAt: null, status: "CONFIRMED" },
    select: { amount: true },
  });
  const outstanding = netOutstanding(invoices, payments);

  // Candidates for linking: the mirror of getGuardian's "students not already
  // tied to this guardian" — guardians not already tied to THIS student.
  const linkedGuardianIds = new Set(student.guardians.map((link) => link.guardianId));
  const availableGuardians = await prisma.guardian.findMany({
    where: { deletedAt: null, id: { notIn: [...linkedGuardianIds] } },
    select: { id: true, firstName: true, lastName: true, phone: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    take: 500,
  });

  return { student, year, enrollments, invoices, termResults, outstanding, availableGuardians };
}
