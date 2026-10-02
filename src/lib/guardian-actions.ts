"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type GuardianRelationship } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { normalisePhone } from "@/lib/sms-shared";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";

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
  setTenantContext({ schoolId: auth.schoolId });

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
  setTenantContext({ schoolId: auth.schoolId });

  const guardianId = String(formData.get("guardianId") ?? "");
  const studentId = String(formData.get("studentId") ?? "");
  const relationship = String(formData.get("relationship") ?? "GUARDIAN") as GuardianRelationship;
  const checkedPrimary = formData.get("isPrimary") === "on";

  if (!guardianId || !studentId) {
    return { error: "Pick a student to link." };
  }
  if (!RELATIONSHIPS.includes(relationship)) {
    return { error: "Pick a relationship." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    /**
     * ⚠️ The FIRST guardian a student gets is always primary, box ticked or
     * not — otherwise a student with none on file stays reading "None on
     * file" on the pupils list (which shows the PRIMARY guardian only) even
     * though a guardian was genuinely just linked. See addGuardianToStudent
     * in student-actions.ts, which had the identical gap.
     */
    const hadAnyGuardian = (await tx.studentGuardian.count({ where: { studentId } })) > 0;
    const isPrimary = checkedPrimary || !hadAnyGuardian;

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
  // Also reached from the student's own page now (linking an existing
  // guardian to a student being edited), which is a route this action never
  // used to touch.
  revalidatePath(`/students/${studentId}`);
  revalidatePath("/students");
  return { ok: "Linked." };
}

export async function unlinkStudent(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
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
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
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

/**
 * Give a guardian a login to the parent portal.
 *
 * This lives here rather than on /users deliberately. A PARENT membership is
 * worthless — and lands on /no-access — unless `guardianId` is set, and /users
 * never knows which guardian is meant. Creating it from the guardian's own
 * record is what guarantees the link exists, so ASSIGNABLE_ROLES stays free of
 * PARENT on purpose.
 *
 * Signing in by phone is the default because that is how most Ghanaian parents
 * will use it; email is accepted when the school has one.
 */
export async function createGuardianLogin(
  _prev: GuardianState,
  formData: FormData,
): Promise<GuardianState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const guardianId = String(formData.get("guardianId") ?? "");
  if (!guardianId) {
    return { error: "Which guardian is this login for?" };
  }

  const guardian = await prisma.guardian.findUnique({ where: { id: guardianId } });
  if (!guardian) {
    return { error: "That guardian no longer exists." };
  }

  const existing = await prisma.membership.count({
    where: { schoolId: auth.schoolId, guardianId },
  });
  if (existing > 0) {
    return { error: `${guardian.firstName} ${guardian.lastName} already has a portal login.` };
  }

  // A login with no children attached would sign in to an empty portal, which
  // reads as though the school had lost the child. Refuse it with the fix.
  const links = await prisma.studentGuardian.count({
    where: { guardianId, student: { deletedAt: null } },
  });
  if (links === 0) {
    return {
      error: "Link at least one pupil to this guardian first — the portal would otherwise be empty.",
    };
  }

  const email = String(formData.get("email") ?? guardian.email ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? guardian.phone ?? "").trim();
  const normalised = phone ? normalisePhone(phone) : null;

  if (!email && !normalised) {
    return { error: "An email address or a Ghanaian mobile number is needed to sign in." };
  }
  if (phone && !normalised) {
    return { error: "That phone number is not a Ghanaian mobile number, e.g. 0244123456." };
  }

  // User.email and User.phone are globally unique, so a parent with children at
  // two schools would collide here. Say so plainly rather than surfacing a
  // Prisma constraint error.
  const clash = await prisma.user.findFirst({
    where: {
      OR: [...(email ? [{ email }] : []), ...(normalised ? [{ phone: normalised }] : [])],
    },
    select: { id: true },
  });
  if (clash) {
    return { error: "That phone number or email already has an account on School OS." };
  }

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const user = await tx.user.create({
        data: {
          name: `${guardian.firstName} ${guardian.lastName}`,
          email: email || null,
          phone: normalised,
          passwordHash,
          // Temporary: the portal diverts this login to /account/password.
          mustChangePassword: true,
          schoolId: auth.schoolId,
        },
      });

      await tx.membership.create({
        data: {
          schoolId: auth.schoolId,
          userId: user.id,
          role: "PARENT",
          guardianId,
        },
      });

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "guardian.login.create",
        entity: "Guardian",
        entityId: guardianId,
        after: { guardianName: `${guardian.firstName} ${guardian.lastName}` },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That phone number or email already has an account on School OS." };
    }
    throw error;
  }

  revalidatePath(`/guardians/${guardianId}`);
  // The password is shown once, here, because there is nowhere to look it up
  // later — the same contract as a staff login.
  return {
    ok: `Portal login created. Temporary password: ${password} — give it to ${guardian.firstName}. They will be asked to choose their own the first time they sign in.`,
  };
}
