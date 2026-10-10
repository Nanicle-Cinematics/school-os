"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Gender, GuardianRelationship, Residency, StudentStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { admissionBlocked } from "@/lib/capacity";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { writeAudit } from "@/lib/audit";
import { sameGuardian } from "@/lib/guardian-match";
import { normalisePhone } from "@/lib/sms-shared";
import { ownsClasses, ownsHouses, ownsProgrammes, ownsStudents } from "@/lib/ownership";

function mismatchMessage(phone: string, onFile: string) {
  return (
    `${phone} is already on file for ${onFile}, which is not the name you entered. ` +
    `If that is the same person, enter the name as it is on file; if not, check the number — ` +
    `a wrong digit would give another family access to this child's fees and results.`
  );
}

export type StudentState = { error?: string; ok?: string };

const STATUSES: StudentStatus[] = [
  "APPLICANT",
  "ADMITTED",
  "ACTIVE",
  "GRADUATED",
  "WITHDRAWN",
  "TRANSFERRED",
  "SUSPENDED",
];

const RELATIONSHIPS: GuardianRelationship[] = [
  "FATHER", "MOTHER", "GRANDPARENT", "UNCLE", "AUNT", "SIBLING", "GUARDIAN", "OTHER",
];

/**
 * The guardian captured on the admission form, if any.
 *
 * Admitting a child without one is allowed — the office often has the parent's
 * details on a separate form — but it is worth doing here, because a student
 * with no guardian receives no bill, no result and no closing-date notice, and
 * nothing later forces anyone to notice.
 */
function readGuardian(formData: FormData) {
  const name = String(formData.get("guardianName") ?? "").trim();
  const phone = String(formData.get("guardianPhone") ?? "").trim();
  if (!name && !phone) {
    return { guardian: null as null | {
      firstName: string; lastName: string; phone: string;
      relationship: GuardianRelationship; receivesBills: boolean; receivesReports: boolean;
    }, error: null as string | null };
  }
  if (!name) {
    return { guardian: null, error: "Give the guardian a name, or clear their phone number." };
  }
  if (!normalisePhone(phone)) {
    return { guardian: null, error: "That guardian phone is not a Ghanaian mobile number, e.g. 0244123456." };
  }
  const relationship = String(formData.get("guardianRelationship") ?? "GUARDIAN") as GuardianRelationship;
  const parts = name.split(/\s+/);
  return {
    error: null,
    guardian: {
      firstName: parts[0],
      lastName: parts.slice(1).join(" ") || parts[0],
      phone,
      relationship: RELATIONSHIPS.includes(relationship) ? relationship : "GUARDIAN",
      receivesBills: formData.get("guardianReceivesBills") === "on",
      receivesReports: formData.get("guardianReceivesReports") === "on",
    },
  };
}

function optionalDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? new Date(raw) : null;
}

/** The fields shared by admission and editing. */
function readProfile(formData: FormData) {
  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;

  return {
    firstName: String(formData.get("firstName") ?? "").trim(),
    lastName: String(formData.get("lastName") ?? "").trim(),
    middleName: text("middleName"),
    gender: String(formData.get("gender") ?? "") as Gender,
    dateOfBirth: optionalDate(formData.get("dateOfBirth")),
    nationality: text("nationality"),
    hometown: text("hometown"),
    religion: text("religion"),
    language: text("language"),
    bloodGroup: text("bloodGroup"),
    allergies: text("allergies"),
    medicalNotes: text("medicalNotes"),
    specialNeeds: text("specialNeeds"),
    previousSchool: text("previousSchool"),
    residency: (String(formData.get("residency") ?? "DAY") as Residency) ?? "DAY",
    houseId: text("houseId"),
    programmeId: text("programmeId"),
  };
}

function validateProfile(profile: ReturnType<typeof readProfile>): string | null {
  if (!profile.firstName || !profile.lastName) {
    return "Enter both names.";
  }
  if (profile.gender !== "MALE" && profile.gender !== "FEMALE") {
    return "Pick a gender.";
  }
  if (profile.residency !== "DAY" && profile.residency !== "BOARDING") {
    return "Pick day or boarding.";
  }
  return null;
}

/** The class, house and programme a form names must all be this school's own. */
async function foreignPlacement(
  profile: { houseId: string | null; programmeId: string | null },
  classGroupId?: string,
): Promise<string | null> {
  if (!(await ownsClasses([classGroupId]))) {
    return "That class was not found in this school. Reload the page and try again.";
  }
  if (!(await ownsHouses([profile.houseId]))) {
    return "That house was not found in this school. Reload the page and try again.";
  }
  if (!(await ownsProgrammes([profile.programmeId]))) {
    return "That programme was not found in this school. Reload the page and try again.";
  }
  return null;
}

export async function admitStudent(
  _prev: StudentState,
  formData: FormData,
): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const profile = readProfile(formData);
  const invalid = validateProfile(profile);
  if (invalid) {
    return { error: invalid };
  }

  const classGroupId = String(formData.get("classGroupId") ?? "");
  const status = String(formData.get("status") ?? "ACTIVE") as StudentStatus;
  if (!STATUSES.includes(status)) {
    return { error: "Pick a status." };
  }

  const { guardian, error: guardianError } = readGuardian(formData);
  if (guardianError) {
    return { error: guardianError };
  }

  // Ids from the form, read back before anything is written: a foreign-reference
  // constraint ignores row security, so another school's class, house or
  // programme would be accepted and the pupil would point at it.
  const placement = await foreignPlacement(profile, classGroupId);
  if (placement) {
    return { error: placement };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  // Admitting straight into a class is the normal path; without a current year
  // there is no roster to join, and a student with a class but no enrolment
  // would be invisible to invoicing and score entry.
  if (classGroupId && !year) {
    return {
      error: "No academic year is marked current, so nobody can be placed in a class yet.",
    };
  }

  // Checked before the transaction opens: a refusal should cost a count, not a
  // rolled-back write and an admission number burnt out of the sequence.
  const full = await admissionBlocked(auth.schoolId, 1);
  if (full) {
    return { error: full };
  }

  let admissionNo: string;
  try {
  admissionNo = await tenantTransaction(auth.schoolId, async (tx: TenantTx) => {
    const allocated = await nextNumber(
      tx,
      auth.schoolId,
      "ADMISSION",
      takenProbes.admission(tx, auth.schoolId),
    );

    const student = await tx.student.create({
      data: {
        schoolId: auth.schoolId,
        admissionNo: allocated,
        ...profile,
        status,
        admissionDate: optionalDate(formData.get("admissionDate")) ?? new Date(),
        currentClassGroupId: classGroupId || null,
      },
    });

    if (classGroupId && year) {
      await tx.enrollment.create({
        data: {
          schoolId: auth.schoolId,
          studentId: student.id,
          academicYearId: year.id,
          classGroupId,
          status: "ACTIVE",
        },
      });
    }

    if (guardian) {
      // Siblings share a parent: match on the normalised phone so a family of
      // four does not become four copies of the same mother.
      const wanted = normalisePhone(guardian.phone);
      const candidates = await tx.guardian.findMany({
        where: { deletedAt: null },
        select: { id: true, phone: true, firstName: true, lastName: true },
      });
      const existing = candidates.find((c) => normalisePhone(c.phone) === wanted);
      if (
        existing &&
        !sameGuardian(`${guardian.firstName} ${guardian.lastName}`, `${existing.firstName} ${existing.lastName}`)
      ) {
        throw new Error(`GUARDIAN_MISMATCH:${existing.firstName} ${existing.lastName}`);
      }

      const guardianId =
        existing?.id ??
        (
          await tx.guardian.create({
            data: {
              schoolId: auth.schoolId,
              firstName: guardian.firstName,
              lastName: guardian.lastName,
              phone: guardian.phone,
            },
          })
        ).id;

      await tx.studentGuardian.create({
        data: {
          schoolId: auth.schoolId,
          studentId: student.id,
          guardianId,
          relationship: guardian.relationship,
          isPrimary: true,
          receivesBills: guardian.receivesBills,
          receivesReports: guardian.receivesReports,
        },
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.admit",
      entity: "Student",
      entityId: student.id,
      after: { admissionNo: allocated, classGroupId: classGroupId || null, status },
    });

    return allocated;
  });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GUARDIAN_MISMATCH:") && guardian) {
      return { error: mismatchMessage(guardian.phone, error.message.slice(18)) };
    }
    throw error;
  }

  revalidatePath("/students");
  revalidatePath("/dashboard");
  return {
    ok: guardian
      ? `Admitted ${profile.firstName} ${profile.lastName} as ${admissionNo}, with ${guardian.firstName} ${guardian.lastName} as their guardian.`
      : `Admitted ${profile.firstName} ${profile.lastName} as ${admissionNo}. Nobody is linked to receive their bills or results — add a guardian next.`,
  };
}

/**
 * A guardian added from the STUDENT's own page — for a child admitted without
 * one, or whose second parent needs linking later. `saveStudent`/EditStudentForm
 * never touched guardians at all, so this was the only entry point missing:
 * admission has the inline fieldset above, and /guardians/[id] can link an
 * existing child, but nothing let the office add a parent while looking at the
 * student record itself.
 *
 * Matches an existing guardian by phone first, exactly as admitStudent does —
 * a family's second child must not create a second copy of the same mother.
 */
export async function addGuardianToStudent(
  _prev: StudentState,
  formData: FormData,
): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const studentId = String(formData.get("studentId") ?? "");
  const name = String(formData.get("guardianName") ?? "").trim();
  const phone = String(formData.get("guardianPhone") ?? "").trim();
  const relationship = String(formData.get("guardianRelationship") ?? "GUARDIAN") as GuardianRelationship;

  if (!studentId) {
    return { error: "Missing student." };
  }
  if (!name) {
    return { error: "Give the guardian a name." };
  }
  if (!normalisePhone(phone)) {
    return { error: "That phone number is not a Ghanaian mobile number, e.g. 0244123456." };
  }
  if (!RELATIONSHIPS.includes(relationship)) {
    return { error: "Pick a relationship." };
  }

  const parts = name.split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(" ") || parts[0];
  const checkedPrimary = formData.get("isPrimary") === "on";
  const receivesBills = formData.get("receivesBills") === "on";
  const receivesReports = formData.get("receivesReports") === "on";
  const isEmergencyContact = formData.get("isEmergencyContact") === "on";

  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
  if (!student) {
    return { error: "That student no longer exists." };
  }

  let addedName = `${firstName} ${lastName}`;

  try {
  await tenantTransaction(auth.schoolId, async (tx: TenantTx) => {
    // Siblings share a parent: match on the normalised phone so a second
    // child does not create a second copy of the same mother.
    const wanted = normalisePhone(phone);
    const candidates = await tx.guardian.findMany({
      where: { deletedAt: null },
      select: { id: true, phone: true, firstName: true, lastName: true },
    });
    const existing = candidates.find((c) => normalisePhone(c.phone) === wanted);
    if (existing && !sameGuardian(name, `${existing.firstName} ${existing.lastName}`)) {
      throw new Error(`GUARDIAN_MISMATCH:${existing.firstName} ${existing.lastName}`);
    }

    const guardianId =
      existing?.id ??
      (
        await tx.guardian.create({
          data: { schoolId: auth.schoolId, firstName, lastName, phone },
        })
      ).id;

    if (existing) {
      addedName = `${existing.firstName} ${existing.lastName}`;
    }

    /**
     * ⚠️ The FIRST guardian a student gets is always primary, whether or not
     * the office ticked the box. admitStudent already does this unconditionally
     * for a guardian captured at admission — this screen exists precisely for
     * the students admission skipped, so it must not need a checkbox to reach
     * the same result. Without this, "add their only guardian" silently left
     * the pupils list reading "None on file" (it only shows the PRIMARY one),
     * which read as though nothing had been saved at all.
     */
    const hadAnyGuardian = (await tx.studentGuardian.count({ where: { studentId } })) > 0;
    const isPrimary = checkedPrimary || !hadAnyGuardian;

    if (isPrimary) {
      await tx.studentGuardian.updateMany({
        where: { studentId, isPrimary: true },
        data: { isPrimary: false },
      });
    }

    await tx.studentGuardian.upsert({
      where: { studentId_guardianId: { studentId, guardianId } },
      create: {
        schoolId: auth.schoolId,
        studentId,
        guardianId,
        relationship,
        isPrimary,
        receivesBills,
        receivesReports,
        isEmergencyContact,
      },
      update: {
        relationship,
        isPrimary,
        receivesBills,
        receivesReports,
        isEmergencyContact,
      },
    });
  });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("GUARDIAN_MISMATCH:")) {
      return { error: mismatchMessage(phone, error.message.slice(18)) };
    }
    throw error;
  }

  revalidatePath(`/students/${studentId}`);
  revalidatePath("/students");
  revalidatePath("/guardians");
  return { ok: `Linked ${addedName} to this student.` };
}

export async function saveStudent(_prev: StudentState, formData: FormData): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  if (!id) {
    return { error: "Missing student." };
  }

  const profile = readProfile(formData);
  const invalid = validateProfile(profile);
  if (invalid) {
    return { error: invalid };
  }

  const status = String(formData.get("status") ?? "ACTIVE") as StudentStatus;
  if (!STATUSES.includes(status)) {
    return { error: "Pick a status." };
  }

  if (!(await ownsStudents([id]))) {
    return { error: "That student was not found in this school." };
  }
  const placement = await foreignPlacement(profile);
  if (placement) {
    return { error: placement };
  }

  await prisma.student.update({
    where: { id },
    data: {
      ...profile,
      status,
      admissionDate: optionalDate(formData.get("admissionDate")),
    },
  });

  revalidatePath(`/students/${id}`);
  revalidatePath("/students");
  return { ok: `Saved ${profile.firstName} ${profile.lastName}.` };
}

/**
 * Place a student in a class for the current year.
 *
 * Enrollment is unique on (student, year), so this is an upsert rather than an
 * insert — moving a child between streams mid-term must not leave them on two
 * rosters. `currentClassGroupId` is the denormalised pointer and is updated in
 * the same transaction, or rosters and filters start disagreeing.
 */
export async function enrolStudent(
  _prev: StudentState,
  formData: FormData,
): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const studentId = String(formData.get("studentId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  if (!studentId || !classGroupId) {
    return { error: "Pick a class." };
  }

  if (!(await ownsStudents([studentId]))) {
    return { error: "That student was not found in this school." };
  }
  if (!(await ownsClasses([classGroupId]))) {
    return { error: "That class was not found in this school. Reload the page and try again." };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (!year) {
    return { error: "No academic year is marked current — set one in Settings first." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.enrollment.upsert({
      where: { studentId_academicYearId: { studentId, academicYearId: year.id } },
      create: {
        schoolId: auth.schoolId,
        studentId,
        academicYearId: year.id,
        classGroupId,
        status: "ACTIVE",
      },
      update: { classGroupId, status: "ACTIVE" },
    });

    await tx.student.update({
      where: { id: studentId },
      data: { currentClassGroupId: classGroupId },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.enrol",
      entity: "Student",
      entityId: studentId,
      after: { academicYearId: year.id, classGroupId },
    });
  });

  revalidatePath(`/students/${studentId}`);
  revalidatePath("/students");
  revalidatePath(`/classes/${classGroupId}`);
  return { ok: "Placed in class." };
}

/**
 * Take a student off the roll without erasing them.
 *
 * Their invoices, payments and results all stay — a school still has to be able
 * to answer "what did this child owe when they left?" years later.
 */
export async function withdrawStudent(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const studentId = String(formData.get("studentId") ?? "");
  const status = String(formData.get("status") ?? "WITHDRAWN") as StudentStatus;

  if (!studentId || !STATUSES.includes(status)) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const before = await tx.student.findUnique({ where: { id: studentId } });
    if (!before) {
      return;
    }

    await tx.student.update({
      where: { id: studentId },
      data: { status, currentClassGroupId: null },
    });

    await tx.enrollment.updateMany({
      where: { studentId, status: "ACTIVE" },
      data: { status: "WITHDRAWN" },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.withdraw",
      entity: "Student",
      entityId: studentId,
      before: { status: before.status, currentClassGroupId: before.currentClassGroupId },
      after: { status },
    });
  });

  revalidatePath(`/students/${studentId}`);
  revalidatePath("/students");
  revalidatePath("/dashboard");
}

/**
 * Undo a delete — the wrong copy of a duplicate, or both of them.
 *
 * Deleting ends the pupil's ACTIVE enrolments (and a data migration ended them
 * for pupils deleted before it did), so restoring has to put them back or the
 * pupil returns with no class. Only enrolments ended AT OR AFTER the delete are
 * reopened: delete and the migration both stamp `updatedAt` no earlier than
 * `deletedAt`, while a pupil who was genuinely withdrawn first carries an older
 * stamp and stays withdrawn.
 */
export async function restoreStudent(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const studentId = String(formData.get("studentId") ?? "");
  if (!studentId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const student = await tx.student.findUnique({
      where: { id: studentId },
      select: { admissionNo: true, firstName: true, lastName: true, deletedAt: true },
    });
    if (!student?.deletedAt) {
      return;
    }
    const ended = await tx.enrollment.findMany({
      where: { studentId, status: "WITHDRAWN", updatedAt: { gte: student.deletedAt } },
      select: { id: true, classGroupId: true, academicYear: { select: { isCurrent: true } } },
    });
    if (ended.length > 0) {
      await tx.enrollment.updateMany({
        where: { id: { in: ended.map((e) => e.id) } },
        data: { status: "ACTIVE" },
      });
    }
    const current = ended.find((e) => e.academicYear.isCurrent);
    await tx.student.update({
      where: { id: studentId },
      data: { deletedAt: null, ...(current ? { currentClassGroupId: current.classGroupId } : {}) },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.restore",
      entity: "Student",
      entityId: studentId,
      before: { deletedAt: student.deletedAt.toISOString() },
      after: {
        admissionNo: student.admissionNo,
        name: `${student.firstName} ${student.lastName}`,
        enrolmentsRestored: ended.length,
        currentClassGroupId: current?.classGroupId ?? null,
      },
    });
  });
  revalidatePath("/students");
  revalidatePath("/classes");
  revalidatePath("/attendance");
  redirect(`/students/${studentId}?restored=1`);
}

/**
 * Remove a record entered by mistake — a duplicate admission, typically.
 *
 * A soft delete: the row stays, with `deletedAt` set, so its audit history
 * and any cancelled paperwork keep something to point at.
 *
 * ⚠️ It used to set `deletedAt` and nothing else. The class registers, mark
 * sheets, results and promotions read the roll from ENROLMENTS, not from the
 * student row, so a deleted duplicate vanished from /students and stayed on
 * the JHS 2 register, was ranked on the broadsheet with no marks, and could no
 * longer be opened to withdraw it. Deleting now ends the enrolment and clears
 * the class in the same transaction, exactly as Withdraw does.
 */
export async function deleteStudent(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const studentId = String(formData.get("studentId") ?? "");
  if (!studentId) {
    return;
  }

  // Only LIVE money blocks it. A duplicate that was billed before anyone noticed
  // has its invoice cancelled by the bursar, and counting cancelled invoices
  // here left that duplicate undeletable for ever — the office's only way out
  // was to withdraw a pupil who never existed. A reversed payment is likewise
  // money already handed back.
  const invoices = await prisma.invoice.count({
    where: { studentId, status: { not: "CANCELLED" } },
  });
  const payments = await prisma.payment.count({ where: { studentId, reversedAt: null } });
  if (invoices > 0 || payments > 0) {
    redirect(`/students/${studentId}?error=has-money`);
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const student = await tx.student.findUnique({
      where: { id: studentId },
      select: {
        admissionNo: true,
        firstName: true,
        lastName: true,
        deletedAt: true,
        currentClassGroupId: true,
      },
    });
    if (!student || student.deletedAt) {
      return;
    }
    await tx.student.update({
      where: { id: studentId },
      data: { deletedAt: new Date(), currentClassGroupId: null },
    });
    const ended = await tx.enrollment.updateMany({
      where: { studentId, status: "ACTIVE" },
      data: { status: "WITHDRAWN" },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "student.delete",
      entity: "Student",
      entityId: studentId,
      before: {
        admissionNo: student.admissionNo,
        name: `${student.firstName} ${student.lastName}`,
        currentClassGroupId: student.currentClassGroupId,
      },
      after: { enrolmentsEnded: ended.count },
    });
  });
  revalidatePath("/students");
  revalidatePath("/classes");
  revalidatePath("/attendance");
  redirect("/students");
}
