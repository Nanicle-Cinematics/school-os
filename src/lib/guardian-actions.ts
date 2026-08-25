"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { GuardianRelationship } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { normalisePhone } from "@/lib/sms-shared";

export type GuardianState = { error?: string; ok?: string };

const RELATIONSHIPS: GuardianRelationship[] = [
  "FATHER",
  "MOTHER",
  "GRANDPARENT",
  "UNCLE",
  "AUNT",
  "SIBLING",
  "GUARDIAN",
  "OTHER",
];

export async function saveGuardian(
  _prev: GuardianState,
  formData: FormData,
): Promise<GuardianState> {
  const auth = await requireRole(OFFICE);

  const id = String(formData.get("id") ?? "");
  const firstName = String(formData.get("firstName") ?? "").trim();
  const lastName = String(formData.get("lastName") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const altPhone = String(formData.get("altPhone") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const occupation = String(formData.get("occupation") ?? "").trim();
  const address = String(formData.get("address") ?? "").trim();
  const gpsAddress = String(formData.get("gpsAddress") ?? "").trim();
  const idType = String(formData.get("idType") ?? "").trim();
  const idNumber = String(formData.get("idNumber") ?? "").trim();

  if (!firstName || !lastName) {
    return { error: "Enter both names." };
  }

  // A guardian whose number cannot be normalised is invisible to every SMS the
  // school sends — bills, results, closing dates. Reject it at the door rather
  // than let it fail silently at send time.
  if (!normalisePhone(phone)) {
    return { error: "That phone number is not a Ghanaian mobile number, e.g. 0244123456." };
  }
  if (altPhone && !normalisePhone(altPhone)) {
    return { error: "The alternate number is not a Ghanaian mobile number." };
  }

  const data = {
    firstName,
    lastName,
    phone,
    altPhone: altPhone || null,
    email: email || null,
    occupation: occupation || null,
    address: address || null,
    gpsAddress: gpsAddress || null,
    idType: idType || null,
    idNumber: idNumber || null,
  };

  if (id) {
    await prisma.guardian.update({ where: { id }, data });
    revalidatePath(`/guardians/${id}`);
    revalidatePath("/guardians");
    return { ok: `Saved ${firstName} ${lastName}.` };
  }

  const guardian = await prisma.guardian.create({
    data: { schoolId: auth.schoolId, ...data },
  });
  revalidatePath("/guardians");
  return { ok: `Added ${guardian.firstName} ${guardian.lastName}. Now link their children.` };
}

export async function linkStudent(
  _prev: GuardianState,
  formData: FormData,
): Promise<GuardianState> {
  const auth = await requireRole(OFFICE);

  const guardianId = String(formData.get("guardianId") ?? "");
  const studentId = String(formData.get("studentId") ?? "");
  const relationship = String(formData.get("relationship") ?? "GUARDIAN") as GuardianRelationship;
  const isPrimary = formData.get("isPrimary") === "on";

  if (!guardianId || !studentId) {
    return { error: "Pick a student to link." };
  }
  if (!RELATIONSHIPS.includes(relationship)) {
    return { error: "Pick a relationship." };
  }

  await tenantTransaction(async (tx) => {
    // One primary guardian per student — that is who the bill and the report
    // card are addressed to, so promoting this one demotes the incumbent.
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
        receivesBills: formData.get("receivesBills") === "on",
        receivesReports: formData.get("receivesReports") === "on",
        isEmergencyContact: formData.get("isEmergencyContact") === "on",
      },
      update: {
        relationship,
        isPrimary,
        receivesBills: formData.get("receivesBills") === "on",
        receivesReports: formData.get("receivesReports") === "on",
        isEmergencyContact: formData.get("isEmergencyContact") === "on",
      },
    });
  });

  revalidatePath(`/guardians/${guardianId}`);
  revalidatePath("/guardians");
  revalidatePath("/students");
  return { ok: "Linked." };
}

export async function unlinkStudent(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const guardianId = String(formData.get("guardianId") ?? "");
  const linkId = String(formData.get("linkId") ?? "");
  if (!linkId) {
    return;
  }

  await prisma.studentGuardian.delete({ where: { id: linkId } });
  revalidatePath(`/guardians/${guardianId}`);
  revalidatePath("/students");
}

export async function deleteGuardian(formData: FormData): Promise<void> {
  await requireRole(OFFICE);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const payments = await prisma.payment.count({ where: { guardianId: id } });
  if (payments > 0) {
    redirect(`/guardians/${id}?error=has-payments`);
  }

  // Soft delete — a guardian who paid nothing may still appear in an old SMS log.
  await prisma.guardian.update({ where: { id }, data: { deletedAt: new Date() } });
  revalidatePath("/guardians");
  redirect("/guardians");
}
