"use server";

import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type Role } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE, LEADERSHIP, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { hashPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { normalisePhone } from "@/lib/sms-shared";
import { ASSIGNABLE_ROLES, PRIVILEGED_ROLES, countOwners } from "@/lib/user-data";

export type UserState = { error?: string; ok?: string };

const WORDS = ["Kente", "Adinkra", "Sankofa", "Bosom", "Akoma", "Gyata", "Odum", "Fufu"];

/**
 * A temporary password the office can read aloud over the phone.
 *
 * Deliberately word + digits rather than random characters: it gets dictated to
 * a teacher who then types it on a phone keyboard, and an unreadable string just
 * becomes a sticky note on the bursar's monitor.
 */
function temporaryPassword() {
  return `${WORDS[randomInt(WORDS.length)]}${randomInt(1000, 10000)}!`;
}

function readRoles(formData: FormData): Role[] {
  const raw = formData.getAll("roles").map(String);
  return ASSIGNABLE_ROLES.filter((role) => raw.includes(role));
}

export async function createUserAccount(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const auth = await requireRole(OFFICE);

  const staffId = String(formData.get("staffId") ?? "");
  const roles = readRoles(formData);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!staffId) {
    return { error: "Pick the staff member this login belongs to." };
  }
  if (roles.length === 0) {
    return { error: "Give the account at least one role, or it can see nothing." };
  }
  // A secretary must not be able to promote themselves to proprietor.
  if (roles.some((role) => PRIVILEGED_ROLES.includes(role)) && !canAccess(auth.roles, LEADERSHIP)) {
    return { error: "Only a proprietor or head can grant leadership roles." };
  }
  if (!email && !phone) {
    return { error: "An email address or a phone number is needed to sign in." };
  }
  if (phone && !normalisePhone(phone)) {
    return { error: "That phone number is not a Ghanaian mobile number, e.g. 0244123456." };
  }

  const staff = await prisma.staff.findUnique({ where: { id: staffId } });
  if (!staff) {
    return { error: "That staff member no longer exists." };
  }

  const existing = await prisma.membership.count({ where: { schoolId: auth.schoolId, staffId } });
  if (existing > 0) {
    return { error: `${staff.firstName} ${staff.lastName} already has a login.` };
  }

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  try {
    await tenantTransaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: `${staff.firstName} ${staff.lastName}`,
          email: email || null,
          phone: phone || null,
          passwordHash,
          schoolId: auth.schoolId,
        },
      });

      await tx.membership.createMany({
        data: roles.map((role) => ({
          schoolId: auth.schoolId,
          userId: user.id,
          role,
          staffId,
          status: "ACTIVE" as const,
          invitedAt: new Date(),
        })),
      });

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "user.create",
        entity: "User",
        entityId: user.id,
        after: { staffId, roles, email: email || null, phone: phone || null },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "That email address or phone number is already used by another login." };
    }
    throw error;
  }

  revalidatePath("/users");
  revalidatePath(`/staff/${staffId}`);
  return {
    ok: `Account created for ${staff.firstName} ${staff.lastName}. Temporary password: ${password} — hand it over now, it is not shown again.`,
  };
}

export async function updateUserRoles(_prev: UserState, formData: FormData): Promise<UserState> {
  const auth = await requireRole(OFFICE);

  const userId = String(formData.get("userId") ?? "");
  const roles = readRoles(formData);

  if (!userId) {
    return { error: "Missing account." };
  }
  if (roles.length === 0) {
    return { error: "An account needs at least one role. Remove its access instead." };
  }

  const current = await prisma.membership.findMany({
    where: { schoolId: auth.schoolId, userId },
  });
  if (current.length === 0) {
    return { error: "That account has no access to this school." };
  }

  const currentRoles = current.map((membership) => membership.role);
  const added = roles.filter((role) => !currentRoles.includes(role));
  const removed = currentRoles.filter((role) => !roles.includes(role));

  if (
    [...added, ...removed].some((role) => PRIVILEGED_ROLES.includes(role)) &&
    !canAccess(auth.roles, LEADERSHIP)
  ) {
    return { error: "Only a proprietor or head can change leadership roles." };
  }

  // Losing the last proprietor locks everyone out of exactly this screen, so it
  // is the one change that cannot be undone from inside the app.
  if (removed.includes("OWNER")) {
    const owners = await countOwners(auth.schoolId);
    if (owners <= 1) {
      return { error: "This is the last proprietor account — give someone else the role first." };
    }
  }

  await tenantTransaction(async (tx) => {
    if (removed.length > 0) {
      await tx.membership.deleteMany({
        where: { schoolId: auth.schoolId, userId, role: { in: removed } },
      });
    }

    if (added.length > 0) {
      await tx.membership.createMany({
        data: added.map((role) => ({
          schoolId: auth.schoolId,
          userId,
          role,
          staffId: current[0].staffId,
          guardianId: current[0].guardianId,
          status: "ACTIVE" as const,
        })),
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "user.roles",
      entity: "User",
      entityId: userId,
      before: { roles: currentRoles },
      after: { roles },
    });
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
  return { ok: "Roles updated. The change applies the next time they load a page." };
}

export async function setAccountSuspended(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  const userId = String(formData.get("userId") ?? "");
  const suspend = String(formData.get("suspend") ?? "") === "1";

  if (!userId) {
    return;
  }
  // Suspending yourself would end the session that is doing the suspending.
  if (userId === auth.userId) {
    redirect("/users?error=self");
  }

  const memberships = await prisma.membership.findMany({
    where: { schoolId: auth.schoolId, userId },
  });
  if (memberships.length === 0) {
    return;
  }
  if (suspend && memberships.some((m) => m.role === "OWNER")) {
    const owners = await countOwners(auth.schoolId);
    if (owners <= 1) {
      redirect("/users?error=last-owner");
    }
  }

  await tenantTransaction(async (tx) => {
    await tx.membership.updateMany({
      where: { schoolId: auth.schoolId, userId },
      data: { status: suspend ? "SUSPENDED" : "ACTIVE" },
    });

    // A suspension that leaves the person signed in is not a suspension.
    if (suspend) {
      await tx.session.deleteMany({ where: { userId } });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: suspend ? "user.suspend" : "user.reinstate",
      entity: "User",
      entityId: userId,
      after: { status: suspend ? "SUSPENDED" : "ACTIVE" },
    });
  });

  revalidatePath(`/users/${userId}`);
  revalidatePath("/users");
}

export async function resetUserPassword(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const auth = await requireRole(OFFICE);
  const userId = String(formData.get("userId") ?? "");
  if (!userId) {
    return { error: "Missing account." };
  }

  const membership = await prisma.membership.findFirst({
    where: { schoolId: auth.schoolId, userId },
  });
  if (!membership) {
    return { error: "That account has no access to this school." };
  }
  if (PRIVILEGED_ROLES.includes(membership.role) && !canAccess(auth.roles, LEADERSHIP)) {
    return { error: "Only a proprietor or head can reset a leadership password." };
  }

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  await tenantTransaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { passwordHash } });
    // Every existing session is invalidated — a reset is usually a response to
    // a lost or shared password, and leaving old sessions alive defeats it.
    await tx.session.deleteMany({ where: { userId } });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "user.password-reset",
      entity: "User",
      entityId: userId,
    });
  });

  revalidatePath(`/users/${userId}`);
  return {
    ok: `New temporary password: ${password} — hand it over now, it is not shown again. They were signed out everywhere.`,
  };
}

export async function removeUserAccess(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  const userId = String(formData.get("userId") ?? "");

  if (!userId) {
    return;
  }
  if (userId === auth.userId) {
    redirect("/users?error=self");
  }

  const memberships = await prisma.membership.findMany({
    where: { schoolId: auth.schoolId, userId },
  });
  if (memberships.length === 0) {
    return;
  }
  if (memberships.some((m) => m.role === "OWNER")) {
    const owners = await countOwners(auth.schoolId);
    if (owners <= 1) {
      redirect("/users?error=last-owner");
    }
  }
  if (
    memberships.some((m) => PRIVILEGED_ROLES.includes(m.role)) &&
    !canAccess(auth.roles, LEADERSHIP)
  ) {
    redirect("/users?error=privileged");
  }

  await tenantTransaction(async (tx) => {
    // The User row survives: it may hold access to another school, and it is
    // named as the actor on payments and audit rows here.
    await tx.membership.deleteMany({ where: { schoolId: auth.schoolId, userId } });
    await tx.session.deleteMany({ where: { userId } });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "user.remove-access",
      entity: "User",
      entityId: userId,
      before: { roles: memberships.map((m) => m.role) },
    });
  });

  revalidatePath("/users");
  redirect("/users");
}
