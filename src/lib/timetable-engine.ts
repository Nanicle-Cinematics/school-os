import "server-only";

import type { AuthContext } from "@/lib/auth";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { ownsClasses } from "@/lib/ownership";
import { writeAudit } from "@/lib/audit";
import {
  findTeacherClash,
  nextLessonPeriod,
  teachersFor,
  weekdayLabel,
  type PlacedLesson,
  type SlotRequest,
} from "@/lib/timetable-rules";

/**
 * Placing, or clearing, one lesson on the timetable.
 *
 * The caller has already run `requireRole` and `setTenantContext`. It is not a
 * "use server" module: every export of one is a callable endpoint, and this one
 * takes the signed-in context as an argument.
 *
 * Everything that can be refused is refused BEFORE anything is written, and a
 * double lesson is all or nothing: a head who asks for two periods never gets
 * one of them.
 */

export type PlaceResult =
  | { error: string }
  | {
      ok: string;
      /** The cells that now hold this subject (or were cleared). */
      cells: { weekday: number; periodId: string }[];
      /** True when nobody is assigned to teach this subject to this class yet. */
      unstaffed: boolean;
    };

export async function placeLesson(
  auth: Pick<AuthContext, "schoolId" | "userId">,
  request: SlotRequest,
): Promise<PlaceResult> {
  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true }, select: { id: true, name: true } });
  if (!year) {
    return { error: "There is no current academic year. Set one under Settings → Terms first." };
  }

  // An id from a request is read back through the tenant client before it is
  // written into a referencing column (see ownership.ts).
  if (!(await ownsClasses([request.classGroupId]))) {
    return { error: "That class was not found." };
  }
  const classGroup = await prisma.classGroup.findUnique({
    where: { id: request.classGroupId },
    select: { id: true, name: true, levelId: true, level: { select: { name: true } } },
  });
  if (!classGroup) {
    return { error: "That class was not found." };
  }
  const classLabel = `${classGroup.level.name} ${classGroup.name}`;

  const periods = await prisma.timetablePeriod.findMany({
    orderBy: { order: "asc" },
    select: { id: true, order: true, label: true, isBreak: true },
  });
  const period = periods.find((p) => p.id === request.periodId);
  if (!period) {
    return { error: "That period was not found. Reload the page." };
  }
  if (period.isBreak) {
    return { error: `${period.label} is a break. Lessons go in the periods between breaks.` };
  }

  const targets = [period];
  if (request.double) {
    const next = nextLessonPeriod(periods, period.id);
    if (!next) {
      return {
        error: `A double lesson needs a lesson period straight after ${period.label}. After it comes a break, or the end of the day.`,
      };
    }
    targets.push(next as (typeof targets)[number]);
  }

  // Clearing needs no more than that.
  if (request.subjectId === "") {
    await tenantTransaction(auth.schoolId, async (tx) => {
      await tx.timetableSlot.deleteMany({
        where: {
          academicYearId: year.id,
          classGroupId: classGroup.id,
          weekday: request.weekday,
          periodId: { in: targets.map((t) => t.id) },
        },
      });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "timetable.slot",
        entity: "ClassGroup",
        entityId: classGroup.id,
        after: { cleared: true, weekday: request.weekday, periods: targets.map((t) => t.label), class: classLabel },
      });
    });
    return {
      ok: `${weekdayLabel(request.weekday)}, ${period.label} is free.`,
      cells: targets.map((t) => ({ weekday: request.weekday, periodId: t.id })),
      unstaffed: false,
    };
  }

  // The subject must be one this class's level actually offers, or the timetable
  // could say a KG class has Mathematics.
  const offered = await prisma.levelSubject.findFirst({
    where: { levelId: classGroup.levelId, subjectId: request.subjectId },
    select: { subject: { select: { name: true } } },
  });
  if (!offered) {
    return { error: `${classLabel} does not offer that subject. Subjects are set under Subjects.` };
  }
  const subjectName = offered.subject.name;

  return tenantTransaction(auth.schoolId, async (tx): Promise<PlaceResult> => {
    // Two heads placing lessons at once would each see a free teacher. Held to
    // commit, per school and year.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"timetable:" + auth.schoolId + ":" + year.id}))`;

    const assignments = await tx.teachingAssignment.findMany({
      where: { academicYearId: year.id },
      select: { staffId: true, classGroupId: true, subjectId: true },
    });
    const staffIds = teachersFor(assignments, classGroup.id, request.subjectId);

    if (staffIds.length > 0) {
      const others = await tx.timetableSlot.findMany({
        where: {
          academicYearId: year.id,
          weekday: request.weekday,
          periodId: { in: targets.map((t) => t.id) },
          classGroupId: { not: classGroup.id },
        },
        select: {
          classGroupId: true,
          subjectId: true,
          weekday: true,
          periodId: true,
          classGroup: { select: { name: true, level: { select: { name: true } } } },
          subject: { select: { name: true } },
        },
      });
      const placed: (PlacedLesson & { subjectName: string })[] = others.map((slot) => ({
        classGroupId: slot.classGroupId,
        classLabel: `${slot.classGroup.level.name} ${slot.classGroup.name}`,
        subjectId: slot.subjectId,
        subjectName: slot.subject.name,
        weekday: slot.weekday,
        periodId: slot.periodId,
        staffIds: teachersFor(assignments, slot.classGroupId, slot.subjectId),
      }));

      for (const target of targets) {
        const clash = findTeacherClash(
          { classGroupId: classGroup.id, weekday: request.weekday, periodId: target.id, staffIds },
          placed,
        );
        if (clash) {
          const teacher = await tx.staff.findUnique({
            where: { id: clash.staffId },
            select: { firstName: true, lastName: true },
          });
          const who = teacher ? `${teacher.firstName} ${teacher.lastName}` : "That teacher";
          const found = placed.find((p) => p === clash.lesson) as (typeof placed)[number];
          return {
            error:
              `${who} teaches ${subjectName} to ${classLabel}, but is already teaching ` +
              `${found.subjectName} to ${clash.lesson.classLabel} on ${weekdayLabel(request.weekday)} in ${target.label}.`,
          };
        }
      }
    }

    for (const target of targets) {
      await tx.timetableSlot.upsert({
        where: {
          classGroupId_academicYearId_weekday_periodId: {
            classGroupId: classGroup.id,
            academicYearId: year.id,
            weekday: request.weekday,
            periodId: target.id,
          },
        },
        create: {
          schoolId: auth.schoolId,
          academicYearId: year.id,
          classGroupId: classGroup.id,
          subjectId: request.subjectId,
          periodId: target.id,
          weekday: request.weekday,
        },
        update: { subjectId: request.subjectId },
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "timetable.slot",
      entity: "ClassGroup",
      entityId: classGroup.id,
      after: {
        subject: subjectName,
        weekday: request.weekday,
        periods: targets.map((t) => t.label),
        class: classLabel,
      },
    });

    return {
      ok: `${subjectName}: ${classLabel}, ${weekdayLabel(request.weekday)}, ${targets.map((t) => t.label).join(" and ")}.`,
      cells: targets.map((t) => ({ weekday: request.weekday, periodId: t.id })),
      unstaffed: staffIds.length === 0,
    };
  });
}
