import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { renderTemplate, countSegments, sendSms, RATE_PER_SEGMENT } from "@/lib/sms";
import { defaultTemplateBody } from "@/lib/message-defaults";

/**
 * The texts the app sends by itself, rather than because someone composed one.
 *
 * ⚠️ This lived in message-actions.ts, which is a `"use server"` module — so it
 * was a registered server action: an entry point taking a school id, a phone
 * number and a body, with no `requireRole` of its own, because every real caller
 * already had one. It is not a form action and never was. A plain module cannot
 * be reached from outside at all, and — the reason this file exists at all —
 * the verify scripts can import it, which a module importing next/navigation
 * cannot be.
 */

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

    /**
     * A missing template used to mean SILENCE, and silence is the failure nobody
     * reports: a parent does not chase a receipt they were never promised. Every
     * school provisioned before templates were seeded was in exactly that state.
     *
     * So fall back to the packaged wording — the same text provisioning would
     * have created. A school that edits its template still gets its own words;
     * one that has none gets the standard message rather than nothing.
     */
    const source = template?.body ?? defaultTemplateBody(args.templateName);
    if (!source) {
      return;
    }

    const body = renderTemplate(source, args.context);
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
