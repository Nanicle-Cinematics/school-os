"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { EmploymentType, Gender, StaffStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import { nextNumber } from "@/lib/sequences";
import { normalisePhone } from "@/lib/sms-shared";

export type StaffState = { error?: string; ok?: string };

const EMPLOYMENT: EmploymentType[] = [
  "FULL_TIME",
  "PART_TIME",
  "NATIONAL_SERVICE",
  "CONTRACT",
  "VOLUNTEER",
];
const STATUSES: StaffStatus[] = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "RESIGNED", "RETIRED"];

function optionalDate(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").trim();
  return raw ? new Date(raw) : null;
}

export async function saveStaff(_prev: StaffState, formData: FormData): Promise<StaffState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const middleName = String(formData.get("middleName") ?? "").trim();
  const gender = String(formData.get("gender") ?? "") as Gender;
  const phone = String(formData.get("phone") ?? "").trim();
  const employmentType = String(formData.get("employmentType") ?? "FULL_TIME") as EmploymentType;
  const status = String(formData.get("status") ?? "ACTIVE") as StaffStatus;

  if (!firstName || !lastName) {
    return { error: "Enter both names." };
  }
  if (gender !== "MALE" && gender !== "FEMALE") {
    return { error: "Pick a gender." };
  }
  if (!EMPLOYMENT.includes(employmentType)) {
    return { error: "Pick an employment type." };
  }
  if (!STATUSES.includes(status)) {
    return { error: "Pick a status." };
  }
  // Staff phones drive the "message all teachers" campaign, so the same rule as
  // guardians applies — but a teacher may genuinely have no number on file.
  if (phone && !normalisePhone(phone)) {
    return { error: "That phone number is not a Ghanaian mobile number, e.g. 0244123456." };
  }

  const data = {
    firstName,
    lastName,
    middleName: middleName || null,
    gender,
    phone: phone || null,
    email: String(formData.get("email") ?? "").trim() || null,
    address: String(formData.get("address") ?? "").trim() || null,
    designation: String(formData.get("designation") ?? "").trim() || null,
    qualification: String(formData.get("qualification") ?? "").trim() || null,
    employmentType,
    isTeaching: formData.get("isTeaching") === "on",
    status,
    dateOfBirth: optionalDate(formData.get("dateOfBirth")),
    dateHired: optionalDate(formData.get("dateHired")),
    ssnitNumber: String(formData.get("ssnitNumber") ?? "").trim() || null,
    tin: String(formData.get("tin") ?? "").trim() || null,
  };

  if (id) {
    await prisma.staff.update({ where: { id }, data });
    revalidatePath(`/staff/${id}`);
    revalidatePath("/staff");
    return { ok: `Saved ${firstName} ${lastName}.` };
  }

  // The staff number and the row have to commit together, or a failed insert
  // burns a number and the file numbers develop a gap nobody can explain.
  const staffNo = await tenantTransaction(auth.schoolId, async (tx: TenantTx) => {
    const allocated = await nextNumber(
      tx,
      auth.schoolId,
      "STAFF",
      async (candidate) => (await tx.staff.count({ where: { staffNo: candidate } })) > 0,
    );

    await tx.staff.create({ data: { schoolId: auth.schoolId, staffNo: allocated, ...data } });
    return allocated;
  });

  revalidatePath("/staff");
  return { ok: `Added ${firstName} ${lastName} as ${staffNo}.` };
}

export async function addTeachingAssignment(
  _prev: StaffState,
  formData: FormData,
): Promise<StaffState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const staffId = String(formData.get("staffId") ?? "");
  const subjectId = String(formData.get("subjectId") ?? "");
  const classGroupId = String(formData.get("classGroupId") ?? "");

  if (!staffId || !subjectId || !classGroupId) {
    return { error: "Pick both a subject and a class." };
  }

  const year = await prisma.academicYear.findFirst({ where: { isCurrent: true } });
  if (!year) {
    return { error: "No academic year is marked current — set one in Settings first." };
  }

  // Assignments gate who may enter scores, so a duplicate is harmless but a
  // missing one locks a teacher out. Upsert keeps the button idempotent.
  await prisma.teachingAssignment.upsert({
    where: {
      academicYearId_staffId_subjectId_classGroupId: {
        academicYearId: year.id,
        staffId,
        subjectId,
        classGroupId,
      },
    },
    create: {
      schoolId: auth.schoolId,
      academicYearId: year.id,
      staffId,
      subjectId,
      classGroupId,
    },
    update: {},
  });

  revalidatePath(`/staff/${staffId}`);
  revalidatePath(`/classes/${classGroupId}`);
  return { ok: "Assignment added." };
}

export async function removeTeachingAssignment(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const staffId = String(formData.get("staffId") ?? "");
  const assignmentId = String(formData.get("assignmentId") ?? "");
  if (!assignmentId) {
    return;
  }

  await prisma.teachingAssignment.delete({ where: { id: assignmentId } });
  revalidatePath(`/staff/${staffId}`);
}

export async function removeStaff(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const [scores, formClasses] = await Promise.all([
    prisma.score.count({ where: { enteredByStaffId: id } }),
    prisma.classGroup.count({ where: { formTeacherId: id } }),
  ]);

  if (scores > 0 || formClasses > 0) {
    redirect(`/staff/${id}?error=in-use`);
  }

  await prisma.staff.update({
    where: { id },
    data: { deletedAt: new Date(), status: "RESIGNED" },
  });
  revalidatePath("/staff");
  redirect("/staff");
}
