import "server-only";

import { prisma } from "@/lib/prisma";
import { normalisePhone, countSegments, RATE_PER_SEGMENT } from "@/lib/sms-shared";

/**
 * Who can be given a parent-portal login, in bulk.
 *
 * Creating them one at a time from /guardians/[id] is a correction path, not a
 * setup path: a 400-pupil school has roughly as many guardians, and the office
 * would also have to read every temporary password down a phone line.
 *
 * Every guardian who is NOT eligible is returned with the reason, rather than
 * silently dropped. A screen that says "38 of 214" and nothing else leaves the
 * office unable to act on the other 176.
 */

export type InviteCandidate = {
  guardianId: string;
  name: string;
  phone: string;
  childCount: number;
};

export type InviteSkip = {
  guardianId: string;
  name: string;
  reason: "already has a login" | "no phone number" | "phone is not a Ghana mobile";
};

export type InvitePlan = {
  candidates: InviteCandidate[];
  skipped: InviteSkip[];
  /** Segments and cost for the whole run, at the sample message length. */
  segments: number;
  cost: number;
  sample: string;
};

/**
 * The message a parent receives. Built inline rather than from a
 * MessageTemplate on purpose: a missing template makes queueTransactionalSms
 * return silently, and an invitation that silently does not send leaves an
 * account created whose password nobody knows.
 */
export function inviteMessage(args: {
  schoolName: string;
  guardianFirstName: string;
  identifier: string;
  password: string;
  url: string;
}) {
  // The number is shown the way a Ghanaian reads it (0244…), not the stored
  // 233… form. Login matches both, so either works — but a parent should not be
  // asked to type a format they have never seen.
  const local = args.identifier.startsWith("233")
    ? `0${args.identifier.slice(3)}`
    : args.identifier;
  return (
    `${args.schoolName}: your parent portal is ready. ` +
    `Sign in at ${args.url} with ${local} and password ${args.password}. ` +
    `You will be asked to choose your own password.`
  );
}

export async function getInvitePlan(
  schoolId: string,
  schoolName: string,
  classGroupId: string | null,
  portalUrl: string,
): Promise<InvitePlan> {
  // Guardians of pupils on roll, optionally narrowed to one class so the office
  // can do this a class at a time rather than the whole school at once.
  const guardians = await prisma.guardian.findMany({
    where: {
      deletedAt: null,
      students: {
        some: {
          student: {
            deletedAt: null,
            status: { in: ["ACTIVE", "ADMITTED"] },
            ...(classGroupId ? { currentClassGroupId: classGroupId } : {}),
          },
        },
      },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      phone: true,
      _count: { select: { students: true } },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  // One query for every existing login rather than one per guardian: a whole
  // school would otherwise be hundreds of round trips.
  const existing = await prisma.membership.findMany({
    where: { schoolId, guardianId: { in: guardians.map((g) => g.id) } },
    select: { guardianId: true },
  });
  const hasLogin = new Set(existing.map((m) => m.guardianId));

  const candidates: InviteCandidate[] = [];
  const skipped: InviteSkip[] = [];

  for (const g of guardians) {
    const name = `${g.firstName} ${g.lastName}`;
    if (hasLogin.has(g.id)) {
      skipped.push({ guardianId: g.id, name, reason: "already has a login" });
      continue;
    }
    if (!g.phone?.trim()) {
      skipped.push({ guardianId: g.id, name, reason: "no phone number" });
      continue;
    }
    const phone = normalisePhone(g.phone);
    if (!phone) {
      skipped.push({ guardianId: g.id, name, reason: "phone is not a Ghana mobile" });
      continue;
    }
    candidates.push({ guardianId: g.id, name, phone, childCount: g._count.students });
  }

  // Cost is estimated from a representative message. A temporary password is a
  // fixed length, so every message is the same size to within a name.
  const sample = inviteMessage({
    schoolName,
    guardianFirstName: candidates[0]?.name.split(" ")[0] ?? "Ama",
    identifier: candidates[0]?.phone ?? "0244000000",
    password: "Xxxxxxxx",
    url: portalUrl,
  });
  const { segments } = countSegments(sample);

  return {
    candidates,
    skipped,
    segments: segments * candidates.length,
    cost: Number((segments * candidates.length * RATE_PER_SEGMENT).toFixed(2)),
    sample,
  };
}
