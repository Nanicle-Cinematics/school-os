"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { Gender, Residency, StudentStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { writeAudit } from "@/lib/audit";

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

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  // Admitting straight into a class is the normal path; without a current year
  // there is no roster to join, and a student with a class but no enrolment
  // would be invisible to invoicing and score entry.
  if (classGroupId && !year) {
    return {
      error: "No academic year is marked current, so nobody can be placed in a class yet.",
    };
  }

  const admissionNo = await tenantTransaction(async (tx: TenantTx) => {
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
    ok: `Admitted ${profile.firstName} ${profile.lastName} as ${admissionNo}. Link a guardian next so bills reach someone.`,
  };
}

export async function saveStudent(_prev: StudentState, formData: FormData): Promise<StudentState> {
  await requireRole(OFFICE);

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

  const studentId = String(formData.get("studentId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");
  if (!studentId || !classGroupId) {
    return { error: "Pick a class." };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (!year) {
    return { error: "No academic year is marked current — set one in Settings first." };
  }

  await tenantTransaction(async (tx) => {
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
  const studentId = String(formData.get("studentId") ?? "");
  const status = String(formData.get("status") ?? "WITHDRAWN") as StudentStatus;

  if (!studentId || !STATUSES.includes(status)) {
    return;
  }

  await tenantTransaction(async (tx) => {
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
  await requireRole(OFFICE);
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
