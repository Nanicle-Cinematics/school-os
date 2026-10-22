import "server-only";

import { Prisma } from "@prisma/client";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { runWithTenantContext, withBypass } from "@/lib/tenant-context";
import { sendSms } from "@/lib/sms";
import { writeAudit } from "@/lib/audit";
import { createLimiter } from "@/lib/concurrency";
import { subscriptionState } from "@/lib/subscription";

/**
 * Getting a campaign's queued messages to the gateway, and the hold in front of it.
 *
 * ⚠️ This is NOT in `message-actions.ts`, which is a "use server" module: every export of one is a callable
 * endpoint, and these take a school id. The page's countdown and the scheduled job both reach them through a
 * checked entry point (`releaseCampaignNow`, the cron route), never directly.
 *
 * The state machine, and the only transitions:
 *   SCHEDULED -> SENDING   a release (claimed with a conditional update, so exactly one caller wins)
 *   SCHEDULED -> CANCELLED the Cancel button, or a school that can no longer send
 *   SENDING   -> SENT | FAILED
 * Cancel and release both update `where status = SCHEDULED`, so they cannot both succeed: whichever commits
 * first leaves the other with count 0. That is the whole race, and it is why neither reads the status first.
 */

/**
 * Push queued messages to the gateway and record what happened to each.
 * Runs outside any write transaction; with no credentials configured every message is marked SENT with a
 * dry-run reference and nothing leaves the building.
 */
export async function dispatchQueued(campaignId: string, schoolId: string, senderId: string | null) {
  const queued = await prisma.message.findMany({
    where: { campaignId, status: "QUEUED" },
    select: { id: true, toPhone: true, body: true, provider: true },
  });

  let sent = 0;
  let failed = 0;
  let dryRun = false;

  // A few at a time, not one by one: a class of 600 at ~1s each would outlive the
  // function. Bounded, so the gateway is not hit with the whole list at once.
  const BATCH = 10;
  // The gateway calls overlap ten at a time, but each outcome is a database write, and
  // under RLS every write is a transaction holding one of the app role's FOUR connections
  // for several round trips. Ten at once filled the whole pool, so everything else on the
  // instance queued behind a campaign and, on a slow link, the tail outlasted the pool's 10s
  // checkout timeout (P2024). Three writes at a time leaves a connection spare. Each message
  // still gets its own update, because providerRef is the gateway's own reference for it
  // and no single updateMany can set a different one per row.
  const recordOutcome = createLimiter(3);
  for (let i = 0; i < queued.length; i += BATCH) {
    await Promise.all(
      queued.slice(i, i + BATCH).map(async (message) => {
        if (!message.toPhone) {
          failed += 1;
          return;
        }
        const result = await sendSms(message.toPhone, message.body, {
          provider: message.provider,
          senderId,
        });
        dryRun = dryRun || result.dryRun;

        await recordOutcome(() =>
          prisma.message.update({
            where: { id: message.id },
            data: {
              status: result.ok ? "SENT" : "FAILED",
              providerRef: result.providerRef ?? null,
              error: result.error ?? (result.dryRun ? "Dry run — no gateway configured" : null),
              sentAt: result.ok ? new Date() : null,
            },
          }),
        );

        if (result.ok) {
          sent += 1;
        } else {
          failed += 1;
        }
      }),
    );
  }

  await prisma.messageCampaign.update({
    where: { id: campaignId },
    data: {
      status: failed > 0 && sent === 0 ? "FAILED" : "SENT",
      sentAt: new Date(),
      sentCount: sent,
      failedCount: failed,
    },
  });

  return { sent, failed, dryRun, schoolId };
}

/**
 * Cancel a campaign that is still held: its status, and every message with it.
 *
 * The messages go to CANCELLED at cost zero, not to nothing: the log still says who WOULD have been texted and
 * that nobody was, and the spend figure (a sum of `Message.cost`) and the daily cap (a count of messages not
 * cancelled) both leave them out. Returns false when the campaign was not SCHEDULED any more (already
 * sending, sent, or cancelled): the caller says so rather than pretending.
 */
export async function cancelHeldCampaign(
  schoolId: string,
  campaignId: string,
  reason: string,
  actorUserId: string | null,
): Promise<boolean> {
  return tenantTransaction(schoolId, async (tx) => {
    const claimed = await tx.messageCampaign.updateMany({
      where: { id: campaignId, status: "SCHEDULED" },
      data: { status: "CANCELLED" },
    });
    if (claimed.count === 0) {
      return false;
    }
    await tx.message.updateMany({
      where: { campaignId, status: "QUEUED" },
      data: { status: "CANCELLED", cost: new Prisma.Decimal(0), error: reason },
    });
    await writeAudit(tx, {
      schoolId,
      actorUserId,
      action: "campaign.cancel",
      entity: "MessageCampaign",
      entityId: campaignId,
      after: { reason },
    });
    return true;
  });
}

export type ReleaseResult =
  | { state: "sent"; sent: number; failed: number }
  | { state: "early"; waitMs: number }
  | { state: "cancelled"; reason: string }
  | { state: "gone" };

/**
 * Release a held campaign whose time has come: claim it, check the school can still send, and dispatch.
 *
 * The caller has set the tenant context. `actorUserId` is the person at the page, or null for the scheduled job.
 * Idempotent: a second caller (a second tab, the job and the page at once) finds the claim taken and gets
 * "gone", and sends nothing.
 */
export async function releaseHeldCampaign(
  schoolId: string,
  campaignId: string,
  actorUserId: string | null,
  now: Date = new Date(),
): Promise<ReleaseResult> {
  const held = await prisma.messageCampaign.findFirst({
    where: { id: campaignId },
    select: { status: true, scheduledAt: true, name: true, audienceType: true, totalRecipients: true },
  });
  if (!held || held.status !== "SCHEDULED") {
    return { state: "gone" };
  }
  if (held.scheduledAt && held.scheduledAt.getTime() > now.getTime()) {
    return { state: "early", waitMs: held.scheduledAt.getTime() - now.getTime() };
  }

  // The school's own switches, read at RELEASE time, not at the moment Send was pressed: five minutes is long
  // enough for someone to turn SMS off, and "off means off" has to hold for a held message too.
  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId } });
  if (!settings?.smsEnabled || !settings.smsProvider) {
    const reason = "SMS was switched off before this could be sent";
    await cancelHeldCampaign(schoolId, campaignId, reason, actorUserId);
    return { state: "cancelled", reason };
  }

  const claimed = await prisma.messageCampaign.updateMany({
    where: { id: campaignId, status: "SCHEDULED", scheduledAt: { lte: now } },
    data: { status: "SENDING" },
  });
  if (claimed.count === 0) {
    return { state: "gone" };
  }

  const result = await dispatchQueued(campaignId, schoolId, settings.smsSenderId ?? null);
  await tenantTransaction(schoolId, (tx) =>
    writeAudit(tx, {
      schoolId,
      actorUserId,
      action: "campaign.send",
      entity: "MessageCampaign",
      entityId: campaignId,
      after: { name: held.name, audienceType: held.audienceType, recipients: held.totalRecipients, released: true },
    }),
  );
  return { state: "sent", sent: result.sent, failed: result.failed };
}

/**
 * The scheduled job's whole body: release every campaign whose hold has run out, across all schools.
 *
 * Reads the list under bypass (it is the one cross-tenant read here), then works each campaign inside its OWN
 * school's context, so row security still scopes every write. A school whose subscription has lapsed to
 * read-only is not allowed to send, and its held campaign is cancelled with that reason rather than left to be
 * retried every five minutes for ever. A cap per run keeps one slow school from outlasting the function.
 */
export async function releaseDueCampaigns(now: Date = new Date(), limit = 25) {
  const due = await withBypass(() =>
    prisma.messageCampaign.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now } },
      orderBy: { scheduledAt: "asc" },
      take: limit,
      select: { id: true, schoolId: true, school: { select: { plan: true, subscriptionStatus: true, trialEndsAt: true, paidUntil: true } } },
    }),
  );

  const summary = { due: due.length, sent: 0, cancelled: 0, skipped: 0 };
  for (const campaign of due) {
    const readOnly = subscriptionState(campaign.school, now).readOnly;
    const outcome = await runWithTenantContext({ schoolId: campaign.schoolId, readOnly }, async () => {
      if (readOnly) {
        // Writes are refused for this school in the ordinary way; the cancel is a platform decision, so it runs
        // under bypass.
        const done = await withBypass(() =>
          cancelHeldCampaign(campaign.schoolId, campaign.id, "The school's subscription had lapsed before this could be sent", null),
        );
        return done ? ({ state: "cancelled" } as const) : ({ state: "gone" } as const);
      }
      return releaseHeldCampaign(campaign.schoolId, campaign.id, null, now);
    });
    if (outcome.state === "sent") summary.sent += 1;
    else if (outcome.state === "cancelled") summary.cancelled += 1;
    else summary.skipped += 1;
  }
  return summary;
}
