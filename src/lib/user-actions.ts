"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type Role } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext, withBypass } from "@/lib/tenant-context";
import { OFFICE, ROLE_ADMIN, ACCOUNT_CREATOR, LEADERSHIP, canAccess } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { normalisePhone } from "@/lib/sms-shared";
import { ASSIGNABLE_ROLES, PRIVILEGED_ROLES, countOwners } from "@/lib/user-data";

export type UserState = { error?: string; ok?: string };

function readRoles(formData: FormData): Role[] {
  const raw = formData.getAll("roles").map(String);
  return ASSIGNABLE_ROLES.filter((role) => raw.includes(role));
}

export async function createUserAccount(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  const auth = await requireRole(ACCOUNT_CREATOR);
  setTenantContext(auth.tenant);

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
  /**
   * ⚠️ ACCOUNT_CREATOR is wider than ROLE_ADMIN, and this is the difference
   * that keeps it safe. An actor who is only here via IT_ADMIN must not be
   * able to grant ACCOUNTANT — that reaches the money, which IT_ADMIN is
   * deliberately kept out of everywhere else (see FINANCE in permissions.ts)
   * — or ADMIN, which IS a ROLE_ADMIN role and would let IT mint a puppet
   * account that reopens this same door. A real ROLE_ADMIN actor (leadership
   * or an existing admin) is unaffected: they could always grant both.
   */
  if (roles.some((role) => role === "ACCOUNTANT" || role === "ADMIN") && !canAccess(auth.roles, ROLE_ADMIN)) {
    return { error: "IT admin may create a staff login, but not one with finance or administrator access." };
  }
  if (!email && !phone) {
    return { error: "An email address or a phone number is needed to sign in." };
  }
  /**
   * ⚠️ Store the NORMALISED number, not what was typed.
   *
   * This validated with normalisePhone and then saved the raw string, so the
   * stored value was whatever shape the office happened to use. Sign-in tries
   * the typed identifier and its normalised form — which rescues a stored
   * normalised number from any input, and cannot rescue a stored raw one. The
   * effect was that a staff member had to type their number in exactly the
   * format the office typed it: "024 412 3456" in the box here meant
   * "0244123456" at the login screen was REFUSED, with the same message as a
   * wrong password and no way to guess why.
   *
   * createGuardianLogin and the bulk portal invite both already stored the
   * normalised form, which is why parents never hit this and staff did.
   */
  const phoneNormalised = phone ? normalisePhone(phone) : null;
  if (phone && !phoneNormalised) {
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

  /**
   * ⚠️ An ORPHANED login is adopted, not refused.
   *
   * "Remove access" deletes the memberships and keeps the User row on purpose —
   * it may hold access to another school, and it is named as the actor on
   * payments and audit rows here. But User.email and User.phone are GLOBALLY
   * unique, so that surviving row goes on holding the person's number while
   * /users cannot show it: that page lists memberships, and this row has none.
   *
   * The result was a dead end with no way out of the product. An office that
   * created a login, missed the one-time password, removed the account and tried
   * again was told "that phone number is already used by another login" — about
   * an account nothing in the app could display, for a member of staff the same
   * screen was simultaneously listing as unable to sign in.
   *
   * So: a row with the same identifier and NO membership anywhere is the same
   * person being re-admitted, and is reused. A row with a membership — at this
   * school or any other — is somebody else's account and is still refused,
   * because adopting it would reset a stranger's password.
   */
  const sameIdentifier = await withBypass(() =>
    prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [...(email ? [{ email }] : []), ...(phoneNormalised ? [{ phone: phoneNormalised }] : [])],
      },
      select: {
        id: true,
        isPlatformAdmin: true,
        _count: { select: { memberships: true } },
      },
    }),
  );

  if (sameIdentifier && (sameIdentifier._count.memberships > 0 || sameIdentifier.isPlatformAdmin)) {
    return {
      error:
        "That email address or phone number already belongs to another login. Use a different one, or remove that account first.",
    };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const user = sameIdentifier
        ? await tx.user.update({
            where: { id: sameIdentifier.id },
            // Re-admitting: a fresh temporary password, and the flag that forces
            // it to be changed. The old hash must not survive — whoever saw it
            // last was not necessarily this person.
            data: {
              name: `${staff.firstName} ${staff.lastName}`,
              email: email || null,
              phone: phoneNormalised,
              passwordHash,
              mustChangePassword: true,
              passwordIssuedAt: new Date(),
              schoolId: auth.schoolId,
            },
          })
        : await tx.user.create({
            data: {
              name: `${staff.firstName} ${staff.lastName}`,
              email: email || null,
              phone: phoneNormalised,
              passwordHash,
              // Temporary: the layouts divert this login to /account/password.
              mustChangePassword: true,
              passwordIssuedAt: new Date(),
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
        after: { staffId, roles, email: email || null, phone: phoneNormalised },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return {
        error:
          "That email address or phone number is already used by another login. If that person's access was removed, try again — a login with no roles left is reused.",
      };
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
  const auth = await requireRole(ROLE_ADMIN);
  setTenantContext(auth.tenant);

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

  // Only roles this screen can assign are edited here. PARENT is not among them
  // (it is created from the guardian's record), so a proprietor who is also a
  // parent must keep that membership rather than have it read as "removed".
  const currentRoles = current
    .map((membership) => membership.role)
    .filter((role) => ASSIGNABLE_ROLES.includes(role));
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

  await tenantTransaction(auth.schoolId, async (tx) => {
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
          staffId: current.find((m) => m.staffId)?.staffId ?? null,
          guardianId: current.find((m) => m.guardianId)?.guardianId ?? null,
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
  // ACCOUNT_SUPPORT, not OFFICE: locking and unlocking a login is the helpdesk
  // job an IT admin exists for. Creating one, changing its roles and removing
  // it stay on OFFICE — see the note on ACCOUNT_SUPPORT.
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
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
  if (
    memberships.some((m) => PRIVILEGED_ROLES.includes(m.role)) &&
    !canAccess(auth.roles, LEADERSHIP)
  ) {
    redirect("/users?error=privileged");
  }
  if (suspend && memberships.some((m) => m.role === "OWNER")) {
    const owners = await countOwners(auth.schoolId);
    if (owners <= 1) {
      redirect("/users?error=last-owner");
    }
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.membership.updateMany({
      where: { schoolId: auth.schoolId, userId },
      data: { status: suspend ? "SUSPENDED" : "ACTIVE" },
    });

    // A suspension that leaves the person signed in is not a suspension.
    if (suspend) {
      // Only sessions working in THIS school: the same login may hold another school's.
      await tx.session.deleteMany({
        where: { userId, OR: [{ activeSchoolId: auth.schoolId }, { activeSchoolId: null }] },
      });
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
  setTenantContext(auth.tenant);
  const userId = String(formData.get("userId") ?? "");
  if (!userId) {
    return { error: "Missing account." };
  }

  // EVERY membership, not the first: one user can hold several roles here, and
  // an unordered findFirst could hand back the harmless one (TEACHER, PARENT)
  // and let an office role reset a head's or proprietor's password.
  const memberships = await prisma.membership.findMany({
    where: { schoolId: auth.schoolId, userId },
  });
  if (memberships.length === 0) {
    return { error: "That account has no access to this school." };
  }
  if (
    memberships.some((m) => PRIVILEGED_ROLES.includes(m.role)) &&
    !canAccess(auth.roles, LEADERSHIP)
  ) {
    return { error: "Only a proprietor or head can reset a leadership password." };
  }

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  await tenantTransaction(auth.schoolId, async (tx) => {
    // An admin reset also hands out a temporary password, so the same rule
    // applies: it gets the account in once, then must be replaced.
    await tx.user.update({
      where: { id: userId },
      data: { passwordHash, mustChangePassword: true, passwordIssuedAt: new Date() },
    });
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
  const auth = await requireRole(ROLE_ADMIN);
  setTenantContext(auth.tenant);
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

  await tenantTransaction(auth.schoolId, async (tx) => {
    // The User row survives: it may hold access to another school, and it is
    // named as the actor on payments and audit rows here.
    await tx.membership.deleteMany({ where: { schoolId: auth.schoolId, userId } });
    // Only sessions working in THIS school: the same login may hold another school's.
    await tx.session.deleteMany({
      where: { userId, OR: [{ activeSchoolId: auth.schoolId }, { activeSchoolId: null }] },
    });

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
