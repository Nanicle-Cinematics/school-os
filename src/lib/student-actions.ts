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
import { normalisePhone } from "@/lib/sms-shared";

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

export async function admitStudent(
  _prev: StudentState,
  formData: FormData,
): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

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

  const admissionNo = await tenantTransaction(auth.schoolId, async (tx: TenantTx) => {
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
        select: { id: true, phone: true },
      });
      const existing = candidates.find((c) => normalisePhone(c.phone) === wanted);

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
  setTenantContext({ schoolId: auth.schoolId });

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
  const isPrimary = formData.get("isPrimary") === "on";
  const receivesBills = formData.get("receivesBills") === "on";
  const receivesReports = formData.get("receivesReports") === "on";
  const isEmergencyContact = formData.get("isEmergencyContact") === "on";

  const student = await prisma.student.findUnique({ where: { id: studentId }, select: { id: true } });
  if (!student) {
    return { error: "That student no longer exists." };
  }

  let addedName = `${firstName} ${lastName}`;

  await tenantTransaction(auth.schoolId, async (tx: TenantTx) => {
    // Siblings share a parent: match on the normalised phone so a second
    // child does not create a second copy of the same mother.
    const wanted = normalisePhone(phone);
    const candidates = await tx.guardian.findMany({
      where: { deletedAt: null },
      select: { id: true, phone: true, firstName: true, lastName: true },
    });
    const existing = candidates.find((c) => normalisePhone(c.phone) === wanted);

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

    // One primary guardian per student — see linkStudent in guardian-actions.ts.
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

  revalidatePath(`/students/${studentId}`);
  revalidatePath("/guardians");
  return { ok: `Linked ${addedName} to this student.` };
}

export async function saveStudent(_prev: StudentState, formData: FormData): Promise<StudentState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

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
  setTenantContext({ schoolId: auth.schoolId });

  const studentId = String(formData.get("studentId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  if (!studentId || !classGroupId) {
    return { error: "Pick a class." };
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
  setTenantContext({ schoolId: auth.schoolId });
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

export async function deleteStudent(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const studentId = String(formData.get("studentId") ?? "");
  if (!studentId) {
    return;
  }

  const invoices = await prisma.invoice.count({ where: { studentId } });
  const payments = await prisma.payment.count({ where: { studentId } });

  // Invoice and Payment cascade from Student at the database level, so removing
  // a billed student here would silently delete money records.
  if (invoices > 0 || payments > 0) {
    redirect(`/students/${studentId}?error=has-money`);
  }

  await prisma.student.update({ where: { id: studentId }, data: { deletedAt: new Date() } });
  revalidatePath("/students");
  redirect("/students");
}
