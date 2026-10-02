import "server-only";

import { createHash, randomInt } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { normalisePhone } from "@/lib/sms-shared";
import { sendSms } from "@/lib/sms";
import { hashPassword } from "@/lib/password";
import { localPhone } from "@/lib/portal-invite-data";

/**
 * A parent who has forgotten their password, without ringing the office.
 *
 * Until now the only way back in was the school resetting it and reading the new
 * one down a phone line — workable for one parent, not for the four hundred a
 * single afternoon on /guardians/invites can create.
 *
 * The whole flow runs BEFORE anyone is signed in, so every query here goes
 * through `withBypass`: there is no tenant context to scope by, and since
 * 2026-09-10 a tenant-scoped query without one is refused rather than silently
 * returning nothing. PasswordReset itself carries no schoolId for the same
 * reason.
 */

/** Long enough to be a nuisance to guess, short enough to read off a handset. */
const CODE_DIGITS = 6;
/** A code is useless after this. Long enough to switch apps and come back. */
const TTL_MINUTES = 15;
/** Wrong guesses before the code dies. 5 of a million is not a search. */
const MAX_ATTEMPTS = 5;
/** Codes one number may ask for per hour, so the form cannot be used as a texting machine. */
const MAX_PER_HOUR = 3;

const MIN_PASSWORD = 8;

function hashCode(code: string) {
  return createHash("sha256").update(code).digest("hex");
}

function newCode() {
  // randomInt, not Math.random: this is a credential.
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
}

/**
 * The parent this number belongs to, or null.
 *
 * PARENT only, deliberately. Staff already have a reset path — the office, on
 * /users, with an audit trail — and a staff login sees the whole school, so a
 * self-service route to one is a much bigger door than this feature needs to
 * open.
 */
async function parentFor(phone: string) {
  return withBypass(() =>
    prisma.user.findFirst({
      where: {
        deletedAt: null,
        phone,
        memberships: { some: { role: "PARENT", status: "ACTIVE" } },
      },
      select: {
        id: true,
        name: true,
        memberships: {
          where: { role: "PARENT", status: "ACTIVE" },
          select: { schoolId: true, school: { select: { name: true } } },
          take: 1,
        },
      },
    }),
  );
}

export type RequestOutcome =
  /** A code was created and handed to the gateway. */
  | { kind: "sent" }
  /** Nothing to send to, or too many asked for. Says the same thing either way. */
  | { kind: "silent" }
  /** No gateway at all, which is about the platform and not about this number. */
  | { kind: "undeliverable" }
  | { kind: "invalid-phone" };

/**
 * Send a reset code, if there is somebody to send it to.
 *
 * ⚠️ The CALLER must say the same thing for "sent" and "silent". Distinguishing
 * them turns this form into a way to ask "does this number belong to a parent at
 * this school?" — a question about a child's family that a stranger should not be
 * able to put to the software.
 */
export async function requestPasswordReset(rawPhone: string): Promise<RequestOutcome> {
  const phone = normalisePhone(rawPhone);
  if (!phone) {
    return { kind: "invalid-phone" };
  }

  // Checked before the lookup and independent of it: whether a gateway exists at
  // all is a fact about the deployment, not about whether this number is known,
  // so saying it plainly leaks nothing and saves a parent waiting for a text
  // that was never going to arrive.
  if (!process.env.SMS_API_KEY || !process.env.SMS_PROVIDER) {
    return { kind: "undeliverable" };
  }

  const user = await parentFor(phone);
  if (!user || user.memberships.length === 0) {
    return { kind: "silent" };
  }

  const since = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await withBypass(() =>
    prisma.passwordReset.count({ where: { userId: user.id, createdAt: { gte: since } } }),
  );
  if (recent >= MAX_PER_HOUR) {
    return { kind: "silent" };
  }

  // Any earlier code stops working the moment a new one is asked for, so two
  // texts in a pocket cannot both open the account.
  await withBypass(() =>
    prisma.passwordReset.updateMany({
      where: { userId: user.id, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
  );

  const code = newCode();
  await withBypass(() =>
    prisma.passwordReset.create({
      data: {
        userId: user.id,
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + TTL_MINUTES * 60 * 1000),
      },
    }),
  );

  const membership = user.memberships[0];
  const settings = await withBypass(() =>
    prisma.schoolSettings.findUnique({ where: { schoolId: membership.schoolId } }),
  );

  const body =
    `${membership.school.name}: your parent portal code is ${code}. ` +
    `It expires in ${TTL_MINUTES} minutes. If you did not ask for it, ignore this message.`;

  const result = await sendSms(phone, body, {
    provider: settings?.smsProvider,
    senderId: settings?.smsSenderId,
  });

  // Recorded like every other outbound text: it costs the school a message, and
  // an undelivered reset is something the office needs to be able to look up.
  await withBypass(() =>
    prisma.message.create({
      data: {
        schoolId: membership.schoolId,
        channel: "SMS",
        toPhone: phone,
        // NOT the code. A message log is read by staff, and a code sitting in it
        // would be a password reset anyone in the office could complete.
        body: `Parent portal reset code sent to ${localPhone(phone)} (code not stored).`,
        status: result.ok ? "SENT" : "FAILED",
        providerRef: result.providerRef ?? null,
        error: result.error ?? null,
        sentAt: result.ok ? new Date() : null,
        provider: settings?.smsProvider ?? null,
        segments: 1,
      },
    }),
  );

  return { kind: "sent" };
}

export type CompleteOutcome =
  | { kind: "ok"; schoolId: string }
  | { kind: "bad-code" }
  | { kind: "weak-password" }
  | { kind: "mismatch" }
  | { kind: "invalid-phone" };

/**
 * Spend the code and set the new password.
 *
 * Every failure answers "bad-code", including an unknown number: the pair of
 * (number, code) is either right or it is not, and saying which half was wrong
 * would hand back the enumeration the request step is careful not to give.
 */
export async function completePasswordReset(args: {
  phone: string;
  code: string;
  password: string;
  confirm: string;
}): Promise<CompleteOutcome> {
  const phone = normalisePhone(args.phone);
  if (!phone) {
    return { kind: "invalid-phone" };
  }
  if (args.password !== args.confirm) {
    return { kind: "mismatch" };
  }
  if (args.password.length < MIN_PASSWORD) {
    return { kind: "weak-password" };
  }

  const user = await parentFor(phone);
  if (!user || user.memberships.length === 0) {
    return { kind: "bad-code" };
  }

  const reset = await withBypass(() =>
    prisma.passwordReset.findFirst({
      where: { userId: user.id, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    }),
  );
  if (!reset || reset.attempts >= MAX_ATTEMPTS) {
    return { kind: "bad-code" };
  }

  /**
   * Spend an attempt BEFORE comparing, as one conditional UPDATE.
   *
   * Reading `attempts`, comparing, then incrementing let a burst of parallel
   * guesses all see "0 of 5" and all be checked — the cap bound a patient
   * guesser and nobody else. The database decides who gets one of the five.
   */
  const claimed = await withBypass(() =>
    prisma.passwordReset.updateMany({
      where: { id: reset.id, consumedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    }),
  );
  if (claimed.count === 0) {
    return { kind: "bad-code" };
  }
  if (reset.codeHash !== hashCode(args.code.trim())) {
    return { kind: "bad-code" };
  }

  const passwordHash = await hashPassword(args.password);

  const spent = await withBypass(() =>
    prisma.passwordReset.updateMany({
      where: { id: reset.id, consumedAt: null },
      data: { consumedAt: new Date() },
    }),
  );
  if (spent.count === 0) {
    // Another request used this code a moment ago; it works once.
    return { kind: "bad-code" };
  }

  await withBypass(async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        // They chose this one themselves, so there is nothing left to force.
        mustChangePassword: false,
        passwordChangedAt: new Date(),
      },
    });
    // EVERY session, including any the person who knew the old password still
    // holds. A reset asked for because something went wrong has to end it.
    await prisma.session.deleteMany({ where: { userId: user.id } });
  });

  return { kind: "ok", schoolId: user.memberships[0].schoolId };
}
