"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma, type AudienceType } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { ownsMessageTemplates } from "@/lib/ownership";
import { resolveAudience, type AudienceFilter } from "@/lib/message-data";
import { renderTemplate, countSegments, estimateCost, sendSms, pupilFieldsUsed, RATE_PER_SEGMENT } from "@/lib/sms";
import { writeAudit } from "@/lib/audit";
import { applyDefaultMessageTemplates } from "@/lib/message-defaults";

export type PreviewState = {
  error?: string;
  count?: number;
  segments?: number;
  encoding?: string;
  cost?: number;
  sample?: { phone: string; body: string }[];
  warnings?: string[];
};

/** One campaign may not name more numbers by hand than a class register has. */
const MAX_CUSTOM_PHONES = 300;
/** Three segments of 160; longer is a letter, and costs the school accordingly. */
const MAX_BODY_LENGTH = 480;
/** Everything one school may send in a day, across campaigns — the platform's gateway account pays for it. */
const MAX_MESSAGES_PER_DAY = 3000;
/** Identical campaign pressed twice, not a second announcement. */
const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
const AUDIENCES: AudienceType[] = ["ALL_PARENTS", "ALL_STAFF", "CLASS", "LEVEL", "DEBTORS", "CUSTOM"];

function readFilter(formData: FormData): AudienceFilter {
  const minBalance = formData.get("minBalance") ? Number(formData.get("minBalance")) : undefined;
  return {
    classGroupIds: formData.getAll("classGroupIds").map(String).filter(Boolean),
    levelIds: formData.getAll("levelIds").map(String).filter(Boolean),
    minBalance: minBalance !== undefined && Number.isFinite(minBalance) ? minBalance : undefined,
    phones: String(formData.get("phones") ?? "")
      .split(/[\s,;]+/)
      .filter(Boolean),
  };
}

function readAudience(formData: FormData): AudienceType | null {
  const value = String(formData.get("audienceType") ?? "ALL_PARENTS") as AudienceType;
  return AUDIENCES.includes(value) ? value : null;
}

/** Resolve the audience and show what would go out, without sending anything. */
export async function previewCampaign(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const body = String(formData.get("body") ?? "").trim();
  const audienceType = readAudience(formData);

  if (!body) {
    return { error: "Write the message first." };
  }
  if (!audienceType) {
    return { error: "Choose who the message is for." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `That message is ${body.length} characters. Keep it under ${MAX_BODY_LENGTH}.` };
  }
  const filterIn = readFilter(formData);
  if ((filterIn.phones?.length ?? 0) > MAX_CUSTOM_PHONES) {
    return { error: `A hand-typed list can hold ${MAX_CUSTOM_PHONES} numbers at most.` };
  }

  const recipients = await resolveAudience(
    auth.schoolId,
    audienceType,
    filterIn,
    auth.schoolName,
  );

  if (recipients.length === 0) {
    return {
      error:
        audienceType === "CLASS" || audienceType === "LEVEL"
          ? "Choose at least one class or level to send to."
          : "No recipients match that audience — nobody has a usable phone number.",
    };
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

  const warnings: string[] = [];
  const blank = audienceType === "CUSTOM" ? pupilFieldsUsed(body) : [];
  if (blank.length > 0) {
    warnings.push(
      `${blank.join(", ")} will be blank for numbers you type in — there is no pupil behind them. ` +
        `Send to a class or level instead, or take those out of the message.`,
    );
  }

  return {
    count: recipients.length,
    segments,
    encoding,
    cost: estimateCost(worst, recipients.length),
    sample: rendered,
    ...(warnings.length > 0 ? { warnings } : {}),
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
  setTenantContext(auth.tenant);

  const name = String(formData.get("name") ?? "").trim() || "Untitled campaign";
  const body = String(formData.get("body") ?? "").trim();
  const audienceType = readAudience(formData);
  const templateId = String(formData.get("templateId") ?? "");
  const confirmed = formData.get("confirm") === "on";

  if (!body) {
    return { error: "Write the message first." };
  }
  if (!audienceType) {
    return { error: "Choose who the message is for." };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { error: `That message is ${body.length} characters. Keep it under ${MAX_BODY_LENGTH}.` };
  }
  const blankFields = audienceType === "CUSTOM" ? pupilFieldsUsed(body) : [];
  if (blankFields.length > 0) {
    return {
      error: `${blankFields.join(", ")} cannot be filled in for numbers you type in — there is no pupil behind them. Send to a class or level instead, or take those out of the message.`,
    };
  }
  if (!confirmed) {
    return { error: "Tick the confirmation box before sending." };
  }
  if (!(await ownsMessageTemplates([templateId]))) {
    return { error: "That template was not found." };
  }

  const filter = readFilter(formData);
  if ((filter.phones?.length ?? 0) > MAX_CUSTOM_PHONES) {
    return { error: `A hand-typed list can hold ${MAX_CUSTOM_PHONES} numbers at most.` };
  }

  /**
   * ⚠️ The school's own SMS switch, which every other text here already obeys.
   *
   * Campaigns ignored it: a school that had left SMS off — or never set it up —
   * still sent through the platform's shared gateway account, which Nanicle
   * pays for. Off means off.
   */
  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });
  if (!settings?.smsEnabled || !settings.smsProvider) {
    return { error: "SMS is switched off for this school. Turn it on under Settings → SMS first." };
  }

  const recipients = await resolveAudience(auth.schoolId, audienceType, filter, auth.schoolName);

  if (recipients.length === 0) {
    return {
      error:
        audienceType === "CLASS" || audienceType === "LEVEL"
          ? "Choose at least one class or level to send to."
          : "No recipients match that audience.",
    };
  }

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sentToday = await prisma.message.count({
    where: { schoolId: auth.schoolId, channel: "SMS", createdAt: { gte: since } },
  });
  if (sentToday + recipients.length > MAX_MESSAGES_PER_DAY) {
    return {
      error: `That would take the school to ${sentToday + recipients.length} texts in a day; the limit is ${MAX_MESSAGES_PER_DAY}. Narrow the audience, or ask Nanicle to raise it.`,
    };
  }

  const repeat = await prisma.messageCampaign.findFirst({
    where: {
      schoolId: auth.schoolId,
      body,
      audienceType,
      createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
    },
    select: { id: true },
  });
  if (repeat) {
    redirect(`/messages/${repeat.id}`);
  }

  const campaignId = await tenantTransaction(auth.schoolId, async (tx) => {
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

  // A few at a time, not one by one: a class of 600 at ~1s each would outlive the
  // function. Bounded, so the gateway is not hit with the whole list at once.
  const BATCH = 10;
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

export type TemplatesState = { error?: string; ok?: string };

/**
 * Give this school the standard messages it should have been provisioned with.
 *
 * Every school created before those were seeded has an empty template table —
 * an empty "start from a template" picker, and, until the fallback above, silent
 * receipts. Idempotent, so it fills a gap left by a deleted template without
 * touching wording the school has edited.
 */
export async function applyStandardMessages(
  // useActionState requires both; the list is fixed and the school comes from
  // the session, so neither is read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: TemplatesState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<TemplatesState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    applyDefaultMessageTemplates(tx, auth.schoolId),
  );

  revalidatePath("/messages");

  if (result.created === 0) {
    return { ok: "Nothing to add — the standard messages are already here." };
  }
  return {
    ok: `Added ${result.created} message${result.created === 1 ? "" : "s"}. Edit the wording to suit the school — the merge fields in braces are filled in when it sends.`,
  };
}
