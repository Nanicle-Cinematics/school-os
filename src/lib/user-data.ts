import "server-only";

import type { Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Queries are sequential rather than Promise.all — see the note in class-data.ts:
// the pool holds one connection, so a fan-out only queues and then times out.

/**
 * Roles a login can be given from this screen.
 *
 * PARENT is deliberately absent, and it is the only role in the enum that is.
 *
 * A PARENT membership is worthless — and lands on /no-access — unless guardianId
 * is set, and this screen never knows which guardian is meant. Parent logins are
 * therefore created from the guardian's own record, which guarantees the link:
 * see createGuardianLogin in guardian-actions.ts. The portal itself is live, so
 * do not "fix" this by adding PARENT here.
 *
 * (STUDENT used to be absent too. It is gone from the enum entirely — it was
 * scaffolding no code ever referenced. See the drop_student_role migration.)
 */
export const ASSIGNABLE_ROLES: Role[] = [
  "OWNER",
  "HEAD",
  "ASSISTANT_HEAD",
  "ADMIN",
  "ACCOUNTANT",
  "TEACHER",
  "LIBRARIAN",
  "HOUSE_MASTER",
  "NURSE",
];

/** Roles that may only be granted by someone who already holds leadership. */
export const PRIVILEGED_ROLES: Role[] = ["OWNER", "HEAD", "ASSISTANT_HEAD"];

export async function getUserList(schoolId: string) {
  // schoolId is passed explicitly rather than left to the tenant context. RLS
  // already scopes it, but this screen hands out access, so a leak here would be
  // an escalation rather than a disclosure — worth the belt as well as braces.
  const memberships = await prisma.membership.findMany({
    where: { schoolId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          lastLoginAt: true,
          deletedAt: true,
          passwordHash: true,
        },
      },
      staff: { select: { id: true, staffNo: true } },
      guardian: { select: { id: true, firstName: true, lastName: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // One row per person, not per role — a Head who also teaches is one login.
  const byUser = new Map<
    string,
    {
      user: (typeof memberships)[number]["user"];
      roles: Role[];
      statuses: string[];
      staffNo: string | null;
      membershipIds: string[];
    }
  >();

  for (const membership of memberships) {
    if (membership.user.deletedAt) {
      continue;
    }
    const entry = byUser.get(membership.userId) ?? {
      user: membership.user,
      roles: [],
      statuses: [],
      staffNo: membership.staff?.staffNo ?? null,
      membershipIds: [],
    };
    entry.roles.push(membership.role);
    entry.statuses.push(membership.status);
    entry.membershipIds.push(membership.id);
    if (!entry.staffNo && membership.staff) {
      entry.staffNo = membership.staff.staffNo;
    }
    byUser.set(membership.userId, entry);
  }

  const users = [...byUser.values()].sort((a, b) => a.user.name.localeCompare(b.user.name));

  // Staff who could be given a login but have none yet — the whole point of the
  // "create account" form, and the fastest way to spot who is locked out.
  const withAccounts = new Set(
    memberships.filter((m) => m.staffId).map((m) => m.staffId as string),
  );

  const staffWithoutAccounts = await prisma.staff.findMany({
    where: {
      deletedAt: null,
      status: { in: ["ACTIVE", "ON_LEAVE"] },
      id: { notIn: [...withAccounts] },
    },
    select: { id: true, staffNo: true, firstName: true, lastName: true, email: true, phone: true },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  return { users, staffWithoutAccounts };
}

export async function getUserAccount(schoolId: string, userId: string) {
  const memberships = await prisma.membership.findMany({
    where: { schoolId, userId },
    include: { staff: { select: { id: true, staffNo: true } } },
    orderBy: { createdAt: "asc" },
  });

  if (memberships.length === 0) {
    return null;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      lastLoginAt: true,
      createdAt: true,
      deletedAt: true,
    },
  });

  if (!user || user.deletedAt) {
    return null;
  }

  const activeSessions = await prisma.session.count({
    where: { userId, expiresAt: { gt: new Date() } },
  });

  return {
    user,
    memberships,
    roles: memberships.map((membership) => membership.role),
    suspended: memberships.every((membership) => membership.status === "SUSPENDED"),
    staffNo: memberships.find((m) => m.staff)?.staff?.staffNo ?? null,
    activeSessions,
  };
}

/** How many people still hold OWNER here — the lockout guard reads this. */
export async function countOwners(schoolId: string) {
  return prisma.membership.count({
    where: { schoolId, role: "OWNER", status: "ACTIVE" },
  });
}
