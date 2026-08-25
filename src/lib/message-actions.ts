"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type AudienceType } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { resolveAudience, type AudienceFilter } from "@/lib/message-data";
import { renderTemplate, countSegments, estimateCost, sendSms, RATE_PER_SEGMENT } from "@/lib/sms";
import { writeAudit } from "@/lib/audit";

export type PreviewState = {
  error?: string;
  count?: number;
  segments?: number;
  encoding?: string;
  cost?: number;
  sample?: { phone: string; body: string }[];
};

function readFilter(formData: FormData): AudienceFilter {
  return {
    classGroupIds: formData.getAll("classGroupIds").map(String).filter(Boolean),
    levelIds: formData.getAll("levelIds").map(String).filter(Boolean),
    minBalance: formData.get("minBalance") ? Number(formData.get("minBalance")) : undefined,
    phones: String(formData.get("phones") ?? "")
      .split(/[\s,;]+/)
      .filter(Boolean),
  };
}

/** Resolve the audience and show what would go out, without sending anything. */
export async function previewCampaign(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const auth = await requireRole(OFFICE);
  const body = String(formData.get("body") ?? "").trim();
  const audienceType = String(formData.get("audienceType") ?? "ALL_PARENTS") as AudienceType;

  if (!body) {
    return { error: "Write the message first." };
  }

  const recipients = await resolveAudience(
    auth.schoolId,
    audienceType,
    readFilter(formData),
    auth.schoolName,
  );

  if (recipients.length === 0) {
    return { error: "No recipients match that audience — nobody has a usable phone number." };
  }

  const rendered = recipients.slice(0, 3).map((recipient) => ({
    phone: recipient.phone,
    body: renderTemplate(body, recipient.context),
  }));

  // Cost is measured on a real rendered message, not the raw template — merge
  // fields routinely push a message over the 160-character boundary.
  const worst = rendered.reduce(
    (longest, item) => (item.body.length > longest.length ? item.body : longest),
    rendered[0].body,
  );
  const { segments, encoding } = countSegments(worst);

  return {
    count: recipients.length,
    segments,
    encoding,
    cost: estimateCost(worst, recipients.length),
    sample: rendered,
  };
}

export type SendState = { error?: string; ok?: string };

/**
 * Create the campaign, render one message per recipient, and dispatch.
 *
 * The campaign and its Message rows are written first, in a transaction, so a
 * gateway failure halfway through still leaves a complete record of what was
 * attempted. Sending happens after the commit — an outbound HTTP call inside a
 * database transaction is how you get a 30-second lock on the messages table.
 */
export async function sendCampaign(_prev: SendState, formData: FormData): Promise<SendState> {
  const auth = await requireRole(OFFICE);

  const name = String(formData.get("name") ?? "").trim() || "Untitled campaign";
  const body = String(formData.get("body") ?? "").trim();
  const audienceType = String(formData.get("audienceType") ?? "ALL_PARENTS") as AudienceType;
  const templateId = String(formData.get("templateId") ?? "");
  const confirmed = formData.get("confirm") === "on";

  if (!body) {
    return { error: "Write the message first." };
  }
  if (!confirmed) {
    return { error: "Tick the confirmation box before sending." };
  }

  const filter = readFilter(formData);
  const recipients = await resolveAudience(auth.schoolId, audienceType, filter, auth.schoolName);

  if (recipients.length === 0) {
    return { error: "No recipients match that audience." };
  }

  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });

  const campaignId = await tenantTransaction(
    async (tx) => {
      const campaign = await tx.messageCampaign.create({
        data: {
          schoolId: auth.schoolId,
          name,
          channel: "SMS",
          templateId: templateId || null,
          body,
          audienceType,
          audienceFilter: filter as unknown as Prisma.InputJsonValue,
          status: "SENDING",
          totalRecipients: recipients.length,
          estimatedCost: new Prisma.Decimal(estimateCost(body, recipients.length).toFixed(2)),
          createdByUserId: auth.userId,
        },
      });

      await tx.message.createMany({
        data: recipients.map((recipient) => {
          const rendered = renderTemplate(body, recipient.context);
          const { segments } = countSegments(rendered);
          return {
            schoolId: auth.schoolId,
            campaignId: campaign.id,
            channel: "SMS" as const,
            toPhone: recipient.phone,
            body: rendered,
            studentId: recipient.studentId ?? null,
            guardianId: recipient.guardianId ?? null,
            staffId: recipient.staffId ?? null,
            provider: settings?.smsProvider ?? null,
            status: "QUEUED" as const,
            segments,
            cost: new Prisma.Decimal((segments * RATE_PER_SEGMENT).toFixed(4)),
          };
        }),
      });

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "campaign.send",
        entity: "MessageCampaign",
        entityId: campaign.id,
        after: { name, audienceType, recipients: recipients.length },
      });

      return campaign.id;
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  await dispatchQueued(campaignId, auth.schoolId, settings?.smsSenderId ?? null);

  revalidatePath("/messages");
  redirect(`/messages/${campaignId}`);
}

/**
 * Push queued messages to the gateway and record what happened to each.
 * Runs outside the write transaction; with no credentials configured every
 * message is marked SENT with a dry-run reference and nothing leaves the
 * building.
 */
async function dispatchQueued(campaignId: string, schoolId: string, senderId: string | null) {
  const queued = await prisma.message.findMany({
    where: { campaignId, status: "QUEUED" },
    select: { id: true, toPhone: true, body: true, provider: true },
  });

  let sent = 0;
  let failed = 0;
  let dryRun = false;

  for (const message of queued) {
    if (!message.toPhone) {
      failed += 1;
      continue;
    }
    const result = await sendSms(message.toPhone, message.body, {
      provider: message.provider,
      senderId,
    });
    dryRun = dryRun || result.dryRun;

    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: result.ok ? "SENT" : "FAILED",
        providerRef: result.providerRef ?? null,
        error: result.error ?? (result.dryRun ? "Dry run — no gateway configured" : null),
        sentAt: result.ok ? new Date() : null,
      },
    });

    if (result.ok) {
      sent += 1;
    } else {
      failed += 1;
    }
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
 * Fire-and-forget transactional SMS: payment receipts, results published.
 * Never throws into the caller — a failed text must not roll back a payment.
 */
export async function queueTransactionalSms(args: {
  schoolId: string;
  templateName: string;
  toPhone: string | null;
  context: Record<string, string | number | null | undefined>;
  studentId?: string;
  guardianId?: string;
}) {
  try {
    const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: args.schoolId } });
    if (!settings?.smsEnabled || !args.toPhone) {
      return;
    }

    const template = await prisma.messageTemplate.findFirst({
      where: { schoolId: args.schoolId, name: args.templateName },
    });
    if (!template) {
      return;
    }

    const body = renderTemplate(template.body, args.context);
    const { segments } = countSegments(body);

    const message = await prisma.message.create({
      data: {
        schoolId: args.schoolId,
        channel: "SMS",
        toPhone: args.toPhone,
        body,
        studentId: args.studentId ?? null,
        guardianId: args.guardianId ?? null,
        provider: settings.smsProvider,
        status: "QUEUED",
        segments,
        cost: new Prisma.Decimal((segments * RATE_PER_SEGMENT).toFixed(4)),
      },
    });

    const result = await sendSms(args.toPhone, body, {
      provider: settings.smsProvider,
      senderId: settings.smsSenderId,
    });

    await prisma.message.update({
      where: { id: message.id },
      data: {
        status: result.ok ? "SENT" : "FAILED",
        providerRef: result.providerRef ?? null,
        error: result.error ?? (result.dryRun ? "Dry run — no gateway configured" : null),
        sentAt: result.ok ? new Date() : null,
      },
    });
  } catch {
    // Deliberately swallowed. The payment succeeded; the text is best-effort.
  }
}
