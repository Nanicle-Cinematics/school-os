import "server-only";

import type { ApplicationStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { loadSeats } from "@/lib/admissions-engine";
import {
  HOLDS_SEAT,
  OPEN_STATUSES,
  STATUS_ORDER,
  lookAlikes,
  offerLapsed,
  seatsFor,
  startableYears,
  type Seats,
} from "@/lib/admissions-rules";

/**
 * What the admissions screens read.
 *
 * A page's queries are awaited one after another, never fanned out: the app role's pool is four connections
 * and every query under row security holds one for several round trips (see CLAUDE.md). The loaders here
 * are a fixed number of bulk reads whatever the number of applications.
 */

export type ApplicationFilter = {
  /** One status, "open" for the working queue, or empty for everything. */
  status?: ApplicationStatus | "open";
  levelId?: string;
  academicYearId?: string;
  q?: string;
};

const LIST_CAP = 400;

export async function getApplyOptions() {
  const levels = await prisma.level.findMany({ orderBy: { order: "asc" }, select: { id: true, name: true } });
  const years = await prisma.academicYear.findMany({
    orderBy: { startDate: "asc" },
    select: { id: true, name: true, isCurrent: true, endDate: true },
  });
  return { levels, years: startableYears(years) };
}

export async function getAdmissionsSettings(schoolId: string) {
  const school = await prisma.school.findUnique({
    where: { id: schoolId },
    select: { slug: true, settings: { select: { applicationsOpen: true, applicationsNote: true } } },
  });
  return {
    slug: school?.slug ?? "",
    open: school?.settings?.applicationsOpen ?? false,
    note: school?.settings?.applicationsNote ?? "",
  };
}

export async function getStatusCounts(schoolId: string): Promise<Record<ApplicationStatus, number>> {
  const rows = await prisma.application.groupBy({ by: ["status"], where: { schoolId }, _count: { _all: true } });
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<ApplicationStatus, number>;
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

export async function getApplications(schoolId: string, filter: ApplicationFilter) {
  const where: Prisma.ApplicationWhereInput = { schoolId };
  if (filter.status === "open") where.status = { in: OPEN_STATUSES };
  else if (filter.status) where.status = filter.status;
  if (filter.levelId) where.levelId = filter.levelId;
  if (filter.academicYearId) where.academicYearId = filter.academicYearId;
  const q = filter.q?.trim();
  if (q) {
    where.OR = [
      { firstName: { contains: q, mode: "insensitive" } },
      { lastName: { contains: q, mode: "insensitive" } },
      { reference: { contains: q, mode: "insensitive" } },
      { guardianName: { contains: q, mode: "insensitive" } },
      { guardianPhone: { contains: q.replace(/\s+/g, "") } },
    ];
  }

  const rows = await prisma.application.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: LIST_CAP + 1,
    include: { level: { select: { name: true } }, academicYear: { select: { name: true } } },
  });
  const truncated = rows.length > LIST_CAP;
  const shown = rows.slice(0, LIST_CAP);

  // Look-alikes among the rows on the screen: cheap, and enough for the office to spot a repeat submission.
  const pool = shown.map((r) => ({
    id: r.id,
    firstName: r.firstName,
    lastName: r.lastName,
    dateOfBirth: r.dateOfBirth,
    guardianPhone: r.guardianPhone,
  }));
  const now = new Date();
  return {
    truncated,
    rows: shown.map((row) => ({
      ...row,
      lapsed: offerLapsed(row, now),
      lookAlikes: lookAlikes(pool.find((p) => p.id === row.id)!, pool).length,
    })),
  };
}

export type SeatRow = { levelId: string; levelName: string; seats: Seats; waiting: number };

/** Every level's places for one year: capacity, enrolled, promised, left, and who is waiting. */
export async function getSeatTable(schoolId: string, academicYearId: string): Promise<SeatRow[]> {
  const levels = await prisma.level.findMany({
    where: { schoolId },
    orderBy: { order: "asc" },
    select: { id: true, name: true, classGroups: { select: { id: true, capacity: true } } },
  });
  const enrolledByClass = await prisma.enrollment.groupBy({
    by: ["classGroupId"],
    where: { schoolId, academicYearId, status: { not: "WITHDRAWN" }, student: { deletedAt: null } },
    _count: { _all: true },
  });
  const promised = await prisma.application.groupBy({
    by: ["levelId"],
    where: { schoolId, academicYearId, status: { in: HOLDS_SEAT } },
    _count: { _all: true },
  });
  const notStarted = await prisma.application.groupBy({
    by: ["levelId"],
    where: { schoolId, academicYearId, status: "ADMITTED", student: { enrollments: { none: { academicYearId } } } },
    _count: { _all: true },
  });
  const waiting = await prisma.application.groupBy({
    by: ["levelId"],
    where: { schoolId, academicYearId, status: "WAITLISTED" },
    _count: { _all: true },
  });

  const enrolled = new Map(enrolledByClass.map((r) => [r.classGroupId, r._count._all]));
  const count = (rows: { levelId: string; _count: { _all: number } }[], id: string) =>
    rows.find((r) => r.levelId === id)?._count._all ?? 0;

  return levels.map((level) => ({
    levelId: level.id,
    levelName: level.name,
    waiting: count(waiting, level.id),
    seats: seatsFor({
      capacities: level.classGroups.map((c) => c.capacity),
      enrolled: level.classGroups.reduce((sum, c) => sum + (enrolled.get(c.id) ?? 0), 0),
      held: count(promised, level.id) + count(notStarted, level.id),
    }),
  }));
}

/** One application with everything its page shows: the places at its level, its classes, and who looks like it. */
export async function getApplicationDetail(schoolId: string, id: string) {
  const application = await prisma.application.findUnique({
    where: { id },
    include: {
      level: { select: { id: true, name: true } },
      academicYear: { select: { id: true, name: true, isCurrent: true } },
      student: { select: { id: true, admissionNo: true, firstName: true, lastName: true } },
    },
  });
  if (!application || application.schoolId !== schoolId) return null;

  const seats = await loadSeats(prisma, schoolId, application.levelId, application.academicYearId);

  const classes = await prisma.classGroup.findMany({
    where: { schoolId, levelId: application.levelId },
    orderBy: { name: "asc" },
    select: { id: true, name: true, capacity: true },
  });
  const enrolledByClass = await prisma.enrollment.groupBy({
    by: ["classGroupId"],
    where: {
      schoolId,
      academicYearId: application.academicYearId,
      status: { not: "WITHDRAWN" },
      student: { deletedAt: null },
      classGroup: { levelId: application.levelId },
    },
    _count: { _all: true },
  });
  const enrolled = new Map(enrolledByClass.map((r) => [r.classGroupId, r._count._all]));

  const otherApplications = await prisma.application.findMany({
    where: { schoolId, lastName: { equals: application.lastName, mode: "insensitive" }, id: { not: id } },
    select: { id: true, reference: true, firstName: true, lastName: true, dateOfBirth: true, guardianPhone: true, status: true },
    take: 50,
  });
  const pupils = await prisma.student.findMany({
    where: { schoolId, deletedAt: null, lastName: { equals: application.lastName, mode: "insensitive" } },
    select: {
      id: true,
      admissionNo: true,
      firstName: true,
      lastName: true,
      dateOfBirth: true,
      guardians: { select: { guardian: { select: { phone: true } } } },
    },
    take: 100,
  });

  const subject = {
    id: application.id,
    firstName: application.firstName,
    lastName: application.lastName,
    dateOfBirth: application.dateOfBirth,
    guardianPhone: application.guardianPhone,
  };
  const sameApplications = new Set(lookAlikes(subject, otherApplications));
  // A pupil's parents may have several phones: the pupil matches when any of them is the applicant's.
  const matchedPupils = pupils.filter((p) =>
    p.guardians.some(
      (g) => lookAlikes(subject, [{ id: p.id, firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dateOfBirth, guardianPhone: g.guardian.phone }]).length > 0,
    ),
  );
  const byBirthday = pupils.filter((p) => lookAlikes(subject, [{ id: p.id, firstName: p.firstName, lastName: p.lastName, dateOfBirth: p.dateOfBirth, guardianPhone: "" }]).length > 0);
  const sharedPupils = [...new Map([...matchedPupils, ...byBirthday].map((p) => [p.id, p])).values()];

  return {
    application,
    lapsed: offerLapsed(application),
    seats,
    classes: classes.map((c) => ({ ...c, enrolled: enrolled.get(c.id) ?? 0 })),
    sameApplications: otherApplications.filter((o) => sameApplications.has(o.id)),
    samePupils: sharedPupils.map((p) => ({ id: p.id, admissionNo: p.admissionNo, name: `${p.firstName} ${p.lastName}` })),
  };
}
