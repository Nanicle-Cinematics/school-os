"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { sendSms } from "@/lib/sms";
import { countSegments, RATE_PER_SEGMENT } from "@/lib/sms-shared";
import { getInvitePlan, inviteMessage, localPhone, type InviteSkip } from "@/lib/portal-invite-data";

/**
 * One run creates at most this many logins.
 *
 * Each one is a scrypt hash, two inserts and an HTTP call to the SMS gateway,
 * and the database is in Frankfurt. A whole 400-pupil school in a single request
 * would sit far past any sensible timeout — the same trap that made provisioning
 * take 465s when it ran row-at-a-time. The screen is built around doing a class
 * at a time, and says plainly when there are more left.
 */
const BATCH_LIMIT = 60;

export type InviteState = {
  error?: string;
  /** Set after a preview; nothing has been written. */
  preview?: {
    /**
     * The audience this preview was computed for, echoed back so the run can be
     * asked for exactly it. The screen must not re-read the class from the form:
     * React resets a form's fields once its action completes, so by the time the
     * Create button is pressed the select has quietly returned to "Every class".
     */
    classGroupId: string | null;
    count: number;
    skipped: InviteSkip[];
    segments: number;
    cost: number;
    sample: string;
    overLimit: number;
  };
  /** Set after a run. */
  result?: {
    created: number;
    texted: number;
    /** Logins whose text did NOT go — the office must pass these on by hand. */
    undelivered: { name: string; phone: string; password: string; why: string }[];
    remaining: number;
  };
};

function portalUrl() {
  return (process.env.APP_URL ?? "https://school-os-lilac.vercel.app").replace(/\/$/, "");
}

/** Show who would be invited and what it would cost. Writes nothing. */
export async function previewInvites(
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const classGroupId = String(formData.get("classGroupId") ?? "") || null;
  const plan = await getInvitePlan(auth.schoolId, auth.schoolName, classGroupId, portalUrl());

  if (plan.candidates.length === 0) {
    return {
      error:
        plan.skipped.length > 0
          ? "Nobody here can be invited yet — see the reasons below."
          : "No guardians found for that class.",
      preview: {
        classGroupId,
        count: 0,
        skipped: plan.skipped,
        segments: 0,
        cost: 0,
        sample: plan.sample,
        overLimit: 0,
      },
    };
  }

  const willSend = Math.min(plan.candidates.length, BATCH_LIMIT);
  const perMessage = countSegments(plan.sample).segments;

  return {
    preview: {
      classGroupId,
      count: willSend,
      skipped: plan.skipped,
      segments: perMessage * willSend,
      cost: Number((perMessage * willSend * RATE_PER_SEGMENT).toFixed(2)),
      sample: plan.sample,
      overLimit: Math.max(0, plan.candidates.length - BATCH_LIMIT),
    },
  };
}

/**
 * Create the logins and text each guardian their temporary password.
 *
 * Per guardian, in its own small transaction — NOT one transaction for the whole
 * run. A single failure part-way through a batch of sixty must not roll back the
 * fifty that already worked and were already texted.
 */
export async function sendInvites(_prev: InviteState, formData: FormData): Promise<InviteState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const classGroupId = String(formData.get("classGroupId") ?? "") || null;
  const plan = await getInvitePlan(auth.schoolId, auth.schoolName, classGroupId, portalUrl());

  if (plan.candidates.length === 0) {
    return { error: "Nobody here can be invited." };
  }

  const batchSize = Math.min(plan.candidates.length, BATCH_LIMIT);

  /**
   * Create exactly the number the office was shown, or nothing at all.
   *
   * This is what stands between a mis-submitted field and a whole school's worth
   * of accounts: the screen once offered "Create 3 logins" while the form beneath
   * it had reverted to every class, and the run created 43. A count that no longer
   * matches means the audience is not the one that was checked — whether the form
   * lost the class or a pupil was admitted in between — and the answer to that is
   * to look again, not to guess which was meant.
   */
  const expected = Number(formData.get("expectedCount"));
  if (!Number.isInteger(expected) || expected <= 0) {
    return { error: "Check who will be invited first — then create the logins." };
  }
  if (expected !== batchSize) {
    return {
      error:
        `This would create ${batchSize} login${batchSize === 1 ? "" : "s"}, but you were shown ` +
        `${expected}. Nothing has been created — press Preview again to see who is now on the list.`,
    };
  }

  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });
  const smsLive = Boolean(settings?.smsEnabled && settings?.smsProvider);

  const batch = plan.candidates.slice(0, batchSize);
  let created = 0;
  let texted = 0;
  const undelivered: NonNullable<InviteState["result"]>["undelivered"] = [];

  for (const c of batch) {
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const body = inviteMessage({
      schoolName: auth.schoolName,
      guardianFirstName: c.name.split(" ")[0],
      identifier: c.phone,
      password,
      url: portalUrl(),
    });

    try {
      await tenantTransaction(auth.schoolId, async (tx) => {
        const user = await tx.user.create({
          data: {
            name: c.name,
            phone: c.phone,
            passwordHash,
            // Temporary: the portal diverts them to /account/password.
            mustChangePassword: true,
            schoolId: auth.schoolId,
          },
        });
        await tx.membership.create({
          data: {
            schoolId: auth.schoolId,
            userId: user.id,
            role: "PARENT",
            guardianId: c.guardianId,
          },
        });
        await writeAudit(tx, {
          schoolId: auth.schoolId,
          actorUserId: auth.userId,
          action: "guardian.login.create",
          entity: "Guardian",
          entityId: c.guardianId,
          after: { guardianName: c.name },
        });
      });
    } catch (error) {
      // User.phone is globally unique, so a guardian who already has an account
      // at another school collides here. Report it rather than aborting the run.
      const why =
        error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? "that phone number already has a School OS account"
          : "the login could not be created";
      undelivered.push({ name: c.name, phone: localPhone(c.phone), password: "—", why });
      continue;
    }
    created += 1;

    if (!smsLive) {
      undelivered.push({
        name: c.name,
        phone: localPhone(c.phone),
        password,
        why: "SMS is switched off for this school",
      });
      continue;
    }

    const { segments } = countSegments(body);
    const message = await prisma.message.create({
      data: {
        schoolId: auth.schoolId,
        channel: "SMS",
        toPhone: c.phone,
        body,
        guardianId: c.guardianId,
        provider: settings?.smsProvider ?? null,
        status: "QUEUED",
        segments,
        cost: new Prisma.Decimal((segments * RATE_PER_SEGMENT).toFixed(4)),
      },
      select: { id: true },
    });

    const sent = await sendSms(c.phone, body, {
      provider: settings?.smsProvider,
      senderId: settings?.smsSenderId,
    });

    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: sent.ok ? "SENT" : "FAILED",
        providerRef: sent.providerRef ?? null,
        error: sent.error ?? (sent.dryRun ? "Dry run — no gateway configured" : null),
        sentAt: sent.ok ? new Date() : null,
      },
    });

    if (sent.ok && !sent.dryRun) {
      texted += 1;
    } else {
      // The account exists. If the text did not actually leave, the office is
      // the only route the password has — so it is shown, once, here.
      undelivered.push({
        name: c.name,
        phone: localPhone(c.phone),
        password,
        why: sent.dryRun ? "no SMS gateway configured (dry run)" : (sent.error ?? "the text failed"),
      });
    }
  }

  revalidatePath("/guardians/invites");
  return {
    result: {
      created,
      texted,
      undelivered,
      remaining: Math.max(0, plan.candidates.length - batch.length),
    },
  };
}
