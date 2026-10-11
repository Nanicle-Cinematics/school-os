import "server-only";

import { prisma } from "@/lib/prisma";
import { TEMP_PASSWORD_MAX_LENGTH } from "@/lib/password";
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
 * 233540000035 -> 0540000035. Phones are stored normalised, but that is not a
 * form any Ghanaian recognises — and the office reads these numbers aloud.
 * Shared so the SMS and the on-screen list cannot show different things.
 */
export function localPhone(stored: string) {
  return stored.startsWith("233") ? `0${stored.slice(3)}` : stored;
}

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
  // Shown the way a Ghanaian reads it. Login matches both forms, so either
  // works — but a parent should not be asked to type one they have never seen.
  const local = localPhone(args.identifier);
  return (
    `${args.schoolName}: your parent portal is ready. ` +
    `Sign in at ${args.url} with ${local} and password ${args.password}. ` +
    `You will be asked to choose your own password.`
  );
}

/**
 * What stands in for the password in the copy of the message that is KEPT.
 *
 * Reads like the password-reset log's "(code not stored)" on purpose: the two flows should
 * look the same to whoever reads the log, and "not stored" says it is deliberate rather
 * than a bug.
 */
export const STORED_PASSWORD_MASK = "(not stored)";

/**
 * The invite twice: the text that goes to the gateway, and the text that goes in the log.
 *
 * ⚠️ They are different on purpose. The message log is read by staff, shows up in backups and
 * outlives the password — which the parent is made to replace at first sign-in — so a
 * temporary password sitting in it is a login anyone with read access can use until that
 * happens (and for 14 days if it never does). The password-reset flow has always logged
 * "(code not stored)"; guardian invites logged the whole text, password and all, from the day
 * they shipped until 2026-10-11 (found in that day's security review). Send `send`, STORE
 * `store`, and never the other way round — verify:password checks that the invite action does.
 */
export function inviteMessages(args: Parameters<typeof inviteMessage>[0]) {
  return {
    send: inviteMessage(args),
    store: inviteMessage({ ...args, password: STORED_PASSWORD_MASK }),
  };
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

  // Cost is estimated from the LONGEST message a temporary password can make, so the
  // estimate never comes in under what is sent. (It was an 8-character stand-in, which was
  // fine while a password was 10 characters and is not now that one runs to 26.)
  const sample = inviteMessage({
    schoolName,
    guardianFirstName: candidates[0]?.name.split(" ")[0] ?? "Ama",
    identifier: candidates[0]?.phone ?? "0244000000",
    password: "x".repeat(TEMP_PASSWORD_MAX_LENGTH),
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
