import "server-only";

import { writeAudit } from "@/lib/audit";
import { lockOn } from "@/lib/locks";
import { ownsAcademicYears, ownsClasses, ownsLevels } from "@/lib/ownership";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { admitPupil } from "@/lib/student-admission";
import {
  HOLDS_SEAT,
  STATUS_LABEL,
  canMove,
  isSettled,
  offerRefusal,
  seatsFor,
  startableYears,
  type ApplicationInput,
  type Seats,
} from "@/lib/admissions-rules";
import type { ApplicationSource, ApplicationStatus } from "@prisma/client";

/**
 * Everything that changes an application, and the seat count they all answer to.
 *
 * The caller has already run `requireRole` (or, for the public form, checked the school's switch) and set
 * the tenant context. Not a "use server" module: every export of one is a callable endpoint, and these take
 * the school as an argument.
 *
 * Each step is refused BEFORE anything is written, and a decision that spends a seat takes an advisory lock
 * on (school, level, year) first, so two people offering the last place at once cannot both be told yes.
 */

export type Actor = { schoolId: string; userId: string | null };
export type Done = { ok: string };
export type Refused = { error: string };

/** What the seat count reads from. Both the plain client (a page) and a transaction (a decision) satisfy it. */
type SeatDb = Pick<TenantTx, "classGroup" | "enrollment" | "application">;

/**
 * The places left at a level for a year.
 *
 * Enrolled is the year's roster in this level's classes (any state but withdrawn, deleted pupils left out:
 * the term's roll, as everywhere). Held is every place promised and not yet on a roll: offers and
 * acceptances, and admitted pupils of a year that has not started (they have no enrolment to count yet).
 */
export async function loadSeats(db: SeatDb, schoolId: string, levelId: string, academicYearId: string): Promise<Seats> {
  const classes = await db.classGroup.findMany({ where: { schoolId, levelId }, select: { capacity: true } });
  const enrolled = await db.enrollment.count({
    where: {
      schoolId,
      academicYearId,
      status: { not: "WITHDRAWN" },
      classGroup: { levelId },
      student: { deletedAt: null },
    },
  });
  const promised = await db.application.count({
    where: { schoolId, levelId, academicYearId, status: { in: HOLDS_SEAT } },
  });
  const notStarted = await db.application.count({
    where: {
      schoolId,
      levelId,
      academicYearId,
      status: "ADMITTED",
      student: { enrollments: { none: { academicYearId } } },
    },
  });
  return seatsFor({ capacities: classes.map((c) => c.capacity), enrolled, held: promised + notStarted });
}

const label = (a: { firstName: string; lastName: string; reference: string }) => `${a.firstName} ${a.lastName} (${a.reference})`;

/* ───────────────────────────── making one ───────────────────────────── */

/** A level and a year the school can take an application for: this school's own, and a year not yet over. */
async function checkTarget(levelId: string, academicYearId: string): Promise<string | null> {
  if (!(await ownsLevels([levelId]))) return "That class was not found. Reload the page and try again.";
  if (!(await ownsAcademicYears([academicYearId]))) return "That year was not found. Reload the page and try again.";
  const year = await prisma.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true, endDate: true } });
  if (!year || startableYears([year]).length === 0) return "That academic year has already ended. Pick the current year or a later one.";
  return null;
}

export async function createApplication(
  actor: Actor,
  input: ApplicationInput,
  source: ApplicationSource,
): Promise<(Done & { id: string; reference: string }) | Refused> {
  const refusal = await checkTarget(input.levelId, input.academicYearId);
  if (refusal) return { error: refusal };

  const made = await tenantTransaction(actor.schoolId, async (tx) => {
    const reference = await nextNumber(tx, actor.schoolId, "APPLICATION", takenProbes.application(tx, actor.schoolId));
    const application = await tx.application.create({
      data: { ...input, schoolId: actor.schoolId, reference, source },
      select: { id: true, reference: true },
    });
    // Two literal writes, not a ternary: verify:activity finds actions by their `action: "…"` text.
    const audit = {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      entity: "Application",
      entityId: application.id,
      after: { reference, name: `${input.firstName} ${input.lastName}`, source },
    };
    if (source === "ONLINE") await writeAudit(tx, { ...audit, action: "application.submit" });
    else await writeAudit(tx, { ...audit, action: "application.create" });
    return application;
  });

  return { ok: `${input.firstName} ${input.lastName} applied as ${made.reference}.`, id: made.id, reference: made.reference };
}

/* ───────────────────────────── changing one ───────────────────────────── */

export async function updateApplication(actor: Actor, id: string, input: ApplicationInput): Promise<Done | Refused> {
  const refusal = await checkTarget(input.levelId, input.academicYearId);
  if (refusal) return { error: refusal };

  return tenantTransaction(actor.schoolId, async (tx): Promise<Done | Refused> => {
    await lockOn(tx, `application:${id}`);
    const current = await tx.application.findUnique({ where: { id } });
    if (!current) return { error: "That application was not found." };
    if (isSettled(current.status)) {
      return { error: "This child has been admitted. Change the pupil's record instead." };
    }

    // Moving a child who already holds a place to another class or year spends a place there.
    const moved = current.levelId !== input.levelId || current.academicYearId !== input.academicYearId;
    if (moved && HOLDS_SEAT.includes(current.status)) {
      await lockOn(tx, `seats:${actor.schoolId}:${input.levelId}:${input.academicYearId}`);
      const seats = await loadSeats(tx, actor.schoolId, input.levelId, input.academicYearId);
      const level = await tx.level.findUnique({ where: { id: input.levelId }, select: { name: true } });
      const refused = offerRefusal(seats, level?.name ?? "That class");
      if (refused) return { error: refused };
    }

    await tx.application.update({ where: { id }, data: input });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "application.update",
      entity: "Application",
      entityId: id,
      after: { reference: current.reference, name: `${input.firstName} ${input.lastName}` },
    });
    return { ok: "Saved." };
  });
}

export async function recordTest(
  actor: Actor,
  id: string,
  test: { testedOn: Date | null; testScore: number | null; testNotes: string | null },
): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx): Promise<Done | Refused> => {
    await lockOn(tx, `application:${id}`);
    const current = await tx.application.findUnique({ where: { id } });
    if (!current) return { error: "That application was not found." };
    if (isSettled(current.status)) return { error: "This child has been admitted; there is nothing left to test." };

    // Recording a test is the first sign it is under way, so a fresh application moves on by itself. Only that
    // one step: anything later (an offer, the waiting list) is the office's decision and is left alone.
    const status: ApplicationStatus = current.status === "APPLIED" ? "TESTING" : current.status;
    await tx.application.update({
      where: { id },
      data: { testedOn: test.testedOn, testScore: test.testScore, testNotes: test.testNotes, status },
    });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "application.test",
      entity: "Application",
      entityId: id,
      after: { reference: current.reference, name: `${current.firstName} ${current.lastName}`, score: test.testScore },
    });
    return { ok: test.testScore === null ? "Saved." : `Saved: ${test.testScore} out of 100.` };
  });
}

export async function moveApplication(
  actor: Actor,
  id: string,
  to: ApplicationStatus,
  details: { offerExpiresOn?: Date | null; note?: string | null } = {},
): Promise<Done | Refused> {
  if (to === "ADMITTED") {
    return { error: "A child is admitted from the Admit button, which creates the pupil." };
  }

  return tenantTransaction(actor.schoolId, async (tx): Promise<Done | Refused> => {
    await lockOn(tx, `application:${id}`);
    const current = await tx.application.findUnique({
      where: { id },
      include: { level: { select: { name: true } } },
    });
    if (!current) return { error: "That application was not found." };
    if (!canMove(current.status, to)) {
      return { error: `${label(current)} is "${STATUS_LABEL[current.status]}" and cannot be moved to "${STATUS_LABEL[to]}" from there.` };
    }

    // An offer promises a place: counted under a lock so the last one cannot be promised twice. A child who
    // already holds a place (accepted, going back to offered) is not asked for a second.
    if (to === "OFFERED") {
      await lockOn(tx, `seats:${actor.schoolId}:${current.levelId}:${current.academicYearId}`);
      const seats = await loadSeats(tx, actor.schoolId, current.levelId, current.academicYearId);
      const refused = offerRefusal(seats, current.level.name, HOLDS_SEAT.includes(current.status));
      if (refused) return { error: refused };
    }

    const decided = to === "OFFERED" || to === "REJECTED" || to === "WITHDRAWN" || to === "ACCEPTED";
    const reopened = to === "APPLIED";
    await tx.application.update({
      where: { id },
      data: {
        status: to,
        offerExpiresOn: to === "OFFERED" ? (details.offerExpiresOn ?? null) : null,
        // A note belongs to the step it was written for; it does not follow the child to the next one.
        decisionNote: details.note ?? null,
        decidedAt: reopened ? null : decided ? new Date() : current.decidedAt,
      },
    });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "application.move",
      entity: "Application",
      entityId: id,
      before: { status: current.status },
      after: { reference: current.reference, name: `${current.firstName} ${current.lastName}`, status: to },
    });
    return { ok: `${label(current)}: ${STATUS_LABEL[to].toLowerCase()}.` };
  });
}

export async function deleteApplication(actor: Actor, id: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx): Promise<Done | Refused> => {
    await lockOn(tx, `application:${id}`);
    const current = await tx.application.findUnique({ where: { id } });
    if (!current) return { error: "That application was not found." };
    if (isSettled(current.status)) return { error: "This child has been admitted, so the application is part of their record and stays." };
    await tx.application.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "application.delete",
      entity: "Application",
      entityId: id,
      before: { reference: current.reference, name: `${current.firstName} ${current.lastName}`, status: current.status },
    });
    return { ok: `${label(current)} was deleted.` };
  });
}

/* ───────────────────────────── admitting ───────────────────────────── */

/**
 * Turn an accepted application into a pupil.
 *
 * It reuses the office's own admission (`admitPupil`): the number, the cap, the guardian matched by phone,
 * the enrolment and the audit row are written exactly as for a child typed in by hand. If the year the child
 * starts is the current one they are placed in a class now (and become ACTIVE); if it is a later year they
 * are admitted without a class (status ADMITTED), counted against that year's places until the office
 * places them once the year begins.
 */
export async function admitApplication(actor: Actor, id: string, classGroupId: string): Promise<(Done & { studentId: string }) | Refused> {
  const application = await prisma.application.findUnique({
    where: { id },
    include: { academicYear: { select: { id: true, name: true, isCurrent: true, endDate: true } } },
  });
  if (!application) return { error: "That application was not found." };
  if (application.status !== "ACCEPTED") {
    return {
      error:
        application.status === "ADMITTED"
          ? "This child has already been admitted."
          : `Only an accepted application can be admitted; this one is "${STATUS_LABEL[application.status]}".`,
    };
  }
  if (startableYears([application.academicYear]).length === 0) {
    return { error: `${application.academicYear.name} has already ended. Change the year on the application first.` };
  }

  const now = application.academicYear.isCurrent;
  if (now) {
    if (!classGroupId) return { error: "Pick the class to place the child in." };
    if (!(await ownsClasses([classGroupId]))) return { error: "That class was not found. Reload the page and try again." };
    const klass = await prisma.classGroup.findUnique({ where: { id: classGroupId }, select: { levelId: true, capacity: true, name: true, level: { select: { name: true } } } });
    if (!klass || klass.levelId !== application.levelId) {
      return { error: "That class is not in the level the child applied for. Change the level on the application first." };
    }
    if (klass.capacity !== null) {
      const enrolled = await prisma.enrollment.count({
        where: { academicYearId: application.academicYearId, classGroupId, status: { not: "WITHDRAWN" }, student: { deletedAt: null } },
      });
      if (enrolled >= klass.capacity) {
        return { error: `${klass.level.name} ${klass.name} is full (${klass.capacity} places). Pick another class, or raise its capacity.` };
      }
    }
  }

  const parts = application.guardianName.split(/\s+/);
  let alreadyAdmitted = false;
  let outcome;
  try {
    outcome = await admitPupil({
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      profile: {
        firstName: application.firstName,
        middleName: application.middleName,
        lastName: application.lastName,
        gender: application.gender,
        dateOfBirth: application.dateOfBirth,
        previousSchool: application.previousSchool,
        medicalNotes: application.notes,
        residency: "DAY",
      },
      status: now ? "ACTIVE" : "ADMITTED",
      admissionDate: new Date(),
      classGroupId: now ? classGroupId : "",
      yearId: now ? application.academicYearId : null,
      guardian: {
        firstName: parts[0],
        lastName: parts.slice(1).join(" ") || parts[0],
        phone: application.guardianPhone,
        relationship: application.guardianRelationship,
        receivesBills: true,
        receivesReports: true,
      },
      auditExtra: { applicationId: id, reference: application.reference },
      afterCreate: async (tx, studentId) => {
        // The status guard makes a second, simultaneous admit of the same application find nothing to update,
        // and throwing rolls back the pupil it just created.
        const marked = await tx.application.updateMany({
          where: { id, status: "ACCEPTED" },
          data: { status: "ADMITTED", studentId, decidedAt: new Date() },
        });
        if (marked.count !== 1) {
          alreadyAdmitted = true;
          throw new Error("APPLICATION_ALREADY_ADMITTED");
        }
      },
    });
  } catch (error) {
    if (alreadyAdmitted) return { error: "This child has just been admitted by someone else." };
    throw error;
  }

  if (!outcome.ok) return { error: outcome.error };
  return {
    ok: `${application.firstName} ${application.lastName} is admitted as ${outcome.admissionNo}${now ? "" : `. They start in ${application.academicYear.name}; place them in a class once it begins`}.`,
    studentId: outcome.studentId,
  };
}
