import "server-only";

import { prisma } from "@/lib/prisma";

/**
 * Queries here are deliberately sequential, not Promise.all.
 *
 * DATABASE_URL pins `connection_limit=1` (pgBouncer transaction mode), so a
 * fan-out of parallel queries does not run in parallel at all — they queue for
 * the one connection, and on this link the tail of the queue blows past
 * Prisma's 10s pool timeout with P2024. Awaiting in sequence costs nothing and
 * cannot time out that way.
 */

/** Teachers eligible to be a form teacher — anyone still on staff and teaching. */
export async function getTeacherOptions() {
  return prisma.staff.findMany({
    where: { deletedAt: null, status: "ACTIVE", isTeaching: true },
    select: { id: true, firstName: true, lastName: true, staffNo: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
}

export async function getClassSetup() {
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  const levels = await prisma.level.findMany({ orderBy: { order: "asc" } });
  const groups = await prisma.classGroup.findMany({
    orderBy: [{ level: { order: "asc" } }, { name: "asc" }],
    include: {
      level: { select: { id: true, name: true, code: true, order: true, stage: true } },
      formTeacher: { select: { id: true, firstName: true, lastName: true } },
    },
  });
  const teachers = await getTeacherOptions();

  // Roster size is counted for the CURRENT year only, so last year's leavers do
  // not keep a class looking full forever.
  const rosterCounts = year
    ? await prisma.enrollment.groupBy({
        by: ["classGroupId"],
        where: { academicYearId: year.id, status: "ACTIVE" },
        _count: { _all: true },
      })
    : [];

  const enrolled = new Map(rosterCounts.map((row) => [row.classGroupId, row._count._all]));

  return {
    year,
    levels,
    teachers,
    classGroups: groups.map((group) => ({ ...group, enrolled: enrolled.get(group.id) ?? 0 })),
  };
}

export async function getClassGroup(id: string) {
  const classGroup = await prisma.classGroup.findUnique({
    where: { id },
    include: {
      level: { select: { id: true, name: true, code: true, order: true } },
      formTeacher: { select: { id: true, firstName: true, lastName: true } },
    },
  });

  if (!classGroup) {
    return null;
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  const levels = await prisma.level.findMany({ orderBy: { order: "asc" } });
  const teachers = await getTeacherOptions();

  const roster = year
    ? await prisma.enrollment.findMany({
        where: { classGroupId: id, academicYearId: year.id },
        include: {
          student: {
            select: {
              id: true,
              admissionNo: true,
              firstName: true,
              lastName: true,
              gender: true,
              status: true,
            },
          },
        },
        orderBy: [{ student: { lastName: "asc" } }, { student: { firstName: "asc" } }],
      })
    : [];

  const assignments = year
    ? await prisma.teachingAssignment.findMany({
        where: { classGroupId: id, academicYearId: year.id },
        include: {
          subject: { select: { id: true, name: true, code: true } },
          staff: { select: { id: true, firstName: true, lastName: true } },
        },
        orderBy: { subject: { order: "asc" } },
      })
    : [];

  // The subjects this class's LEVEL offers — the rows of the assignment editor.
  // Not every subject in the school: KG must not be offered Mathematics, and a
  // list of eighteen when the level teaches nine is how the wrong one gets
  // picked.
  const offered = await prisma.levelSubject.findMany({
    where: { levelId: classGroup.levelId },
    include: { subject: { select: { id: true, name: true, code: true } } },
    orderBy: [{ order: "asc" }, { subject: { name: "asc" } }],
  });

  const assignedBySubject = new Map(assignments.map((a) => [a.subjectId, a.staffId]));

  // Last year's teachers, offered as the starting point when this year is
  // empty — otherwise a rollover means retyping the whole timetable. Nothing is
  // written until the form is saved.
  const previousYear = year
    ? await prisma.academicYear.findFirst({
        where: { startDate: { lt: year.startDate } },
        orderBy: { startDate: "desc" },
        select: { id: true, name: true },
      })
    : null;

  const previous =
    previousYear && assignments.length === 0
      ? await prisma.teachingAssignment.findMany({
          where: { classGroupId: id, academicYearId: previousYear.id },
          select: { subjectId: true, staffId: true },
        })
      : [];

  const previousBySubject = new Map(previous.map((a) => [a.subjectId, a.staffId]));

  const subjectRows = offered.map((row) => ({
    subjectId: row.subject.id,
    name: row.subject.name,
    code: row.subject.code,
    staffId: assignedBySubject.get(row.subject.id) ?? null,
    previousStaffId: previousBySubject.get(row.subject.id) ?? null,
  }));

  // Across every year, not just the current one — this is the delete guard.
  const totalEnrollments = await prisma.enrollment.count({ where: { classGroupId: id } });

  return {
    classGroup,
    year,
    levels,
    teachers,
    roster,
    assignments,
    subjectRows,
    previousYear: previous.length > 0 ? previousYear : null,
    totalEnrollments,
  };
}
