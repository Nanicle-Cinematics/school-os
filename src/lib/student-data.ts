import "server-only";

import { StudentStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { netOutstanding } from "@/lib/invoice-engine";
import { unplacedWhere } from "@/lib/class-roster";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

const PAGE_SIZE = 50;

export type StudentFilters = {
  q?: string;
  classGroupId?: string;
  status?: string;
  /** "none": on the roll but in no class this academic year (see `unplacedWhere`). */
  placement?: string;
  page?: number;
};

export async function getStudentList(filters: StudentFilters) {
  const query = filters.q?.trim() ?? "";
  const page = Math.max(1, filters.page ?? 1);

  const year =
    filters.placement === "none"
      ? await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true } })
      : null;

  const where: Prisma.StudentWhereInput = {
    deletedAt: null,
    ...(year ? unplacedWhere(year.id) : {}),
    ...(filters.classGroupId ? { currentClassGroupId: filters.classGroupId } : {}),
    ...(filters.status && filters.status in StudentStatus
      ? { status: filters.status as StudentStatus }
      : {}),
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

/**
 * A pupil who was deleted, for the page that offers to restore them. Without
 * it a deleted pupil's link — the class roster still lists their ended
 * enrolment — opened a bare 404, and a school that deleted BOTH copies of a
 * duplicate had no way back to the real child.
 *
 * Carries every other pupil with the same name, live or deleted, because the
 * office is choosing which copy is the real one.
 */
export async function getDeletedStudent(id: string) {
  const student = await prisma.student.findUnique({
    where: { id },
    select: {
      id: true,
      admissionNo: true,
      firstName: true,
      middleName: true,
      lastName: true,
      deletedAt: true,
      createdAt: true,
    },
  });
  if (!student?.deletedAt) {
    return null;
  }

  const deletion = await prisma.auditLog.findFirst({
    where: { entity: "Student", entityId: id, action: "student.delete" },
    orderBy: { createdAt: "desc" },
    select: { actor: { select: { name: true } } },
  });

  const enrolments = await prisma.enrollment.findMany({
    where: { studentId: id, status: "WITHDRAWN", updatedAt: { gte: student.deletedAt } },
    select: {
      id: true,
      academicYear: { select: { name: true } },
      classGroup: { select: { name: true, level: { select: { name: true } } } },
    },
  });

  const namesakes = await prisma.student.findMany({
    where: {
      id: { not: id },
      firstName: { equals: student.firstName, mode: "insensitive" },
      lastName: { equals: student.lastName, mode: "insensitive" },
    },
    select: { id: true, admissionNo: true, deletedAt: true, createdAt: true },
    orderBy: { admissionNo: "asc" },
  });

  return { student, deletedBy: deletion?.actor?.name ?? null, enrolments, namesakes };
}

export async function getStudent(id: string) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      currentClassGroup: { select: { id: true, name: true, level: { select: { name: true, stage: true } } } },
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
      classGroup: { select: { id: true, name: true, level: { select: { name: true, stage: true } } } },
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
  // Every invoice, not the six shown: this is a lifetime figure set against ALL
  // payments, and totalling only the latest few charged less than was paid.
  const charged = await prisma.invoice.findMany({
    where: { studentId: id, status: { not: "CANCELLED" } },
    select: { total: true, broughtForward: true },
  });
  const outstanding = netOutstanding(charged, payments);

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
