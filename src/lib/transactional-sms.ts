import "server-only";

import { Prisma, type SchoolSettings } from "@prisma/client";
import { reportHoldsForClass } from "@/lib/report-access";
import { prisma } from "@/lib/prisma";
import { renderTemplate, countSegments, sendSms, RATE_PER_SEGMENT } from "@/lib/sms";
import { normalisePhone } from "@/lib/sms-shared";
import { defaultTemplateBody, TRANSACTIONAL } from "@/lib/message-defaults";
import { termLabel } from "@/lib/academic-year";

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

/** The switch on Settings → SMS that turns a kind of automatic text off. */
type NotifySetting = "notifyOnPayment" | "notifyOnResultPublish";

type SmsContext = Record<string, string | number | null | undefined>;

/**
 * Send one, with the school's settings already in hand.
 *
 * Split out because publishing a class texts one guardian per pupil, and
 * re-reading SchoolSettings forty times over a link where a round trip is
 * measured in seconds is forty seconds of nothing.
 */
async function deliver(
  settings: SchoolSettings,
  args: {
    schoolId: string;
    templateName: string;
    toPhone: string | null;
    context: SmsContext;
    studentId?: string;
    guardianId?: string;
  },
): Promise<boolean> {
  if (!args.toPhone) {
    return false;
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
    return false;
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

  return true;
}

/**
 * Is this kind of automatic text switched on for this school?
 *
 * ⚠️ `notifyOnPayment` and `notifyOnResultPublish` were written by the settings
 * form, shown back with their saved values, and **read by nothing** — so a school
 * that unticked "text a receipt when a payment is recorded" went on texting
 * receipts, and the tick that promised results texts never sent one. A switch
 * that does nothing is worse than an absent one: it is a written-down claim about
 * the software that isn't true.
 */
async function notifiable(schoolId: string, gate: NotifySetting) {
  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId } });
  if (!settings?.smsEnabled || !settings[gate]) {
    return null;
  }
  return settings;
}

/**
 * Fire-and-forget transactional SMS: one recipient, one message.
 * Never throws into the caller — a failed text must not roll back a payment.
 */
export async function queueTransactionalSms(args: {
  schoolId: string;
  templateName: string;
  /** The Settings switch this text obeys. */
  gate: NotifySetting;
  toPhone: string | null;
  context: SmsContext;
  studentId?: string;
  guardianId?: string;
}) {
  try {
    const settings = await notifiable(args.schoolId, args.gate);
    if (!settings) {
      return;
    }
    await deliver(settings, args);
  } catch {
    // Deliberately swallowed. The payment succeeded; the text is best-effort.
  }
}

/**
 * Tell the parents of a class that its report cards are ready.
 *
 * Only for the pupils this run actually published — re-publishing an already
 * published class must not text every parent a second time and bill the school
 * for it. `setResultsStatus` therefore reads which rows were not yet PUBLISHED
 * before it updates them, and passes those.
 *
 * ⚠️ **Written in bulk, deliberately.** The obvious loop — the one this replaced —
 * called the single-message path once per parent, which re-reads the template and
 * writes the row one at a time: **27 seconds for TWO parents**, measured, with no
 * gateway even configured, because each of those round trips crosses to
 * Frankfurt. A class of forty would have held the form open for minutes. The
 * template is read once, the rows are written in one `createMany`, and the
 * outcomes go back in two updates — so the only part that scales with the class
 * is the gateway call itself, which is the part that genuinely has to.
 *
 * Sent after the transaction has committed: a gateway that is slow or down must
 * delay a text rather than roll back a publication.
 */
export async function textResultsPublished(args: {
  schoolId: string;
  schoolName: string;
  termId: string;
  studentIds: string[];
}): Promise<{ texted: number }> {
  try {
    if (args.studentIds.length === 0) {
      return { texted: 0 };
    }

    const settings = await notifiable(args.schoolId, "notifyOnResultPublish");
    if (!settings) {
      return { texted: 0 };
    }

    const template = await prisma.messageTemplate.findFirst({
      where: { schoolId: args.schoolId, name: TRANSACTIONAL.resultsPublished },
    });
    const source = template?.body ?? defaultTemplateBody(TRANSACTIONAL.resultsPublished);
    if (!source) {
      return { texted: 0 };
    }

    const term = await prisma.term.findUnique({ where: { id: args.termId } });

    // A pupil whose card is held for arrears cannot open it in the portal, so
    // "your results are ready" would send a parent to a page that says otherwise.
    // Leave them out rather than send a text the portal contradicts.
    const holds = await reportHoldsForClass(args.studentIds, args.termId, settings);
    const studentIds = args.studentIds.filter((id) => !holds.has(id));
    if (studentIds.length === 0) {
      return { texted: 0 };
    }

    // `receivesReports` is the guardian's own preference, set on the link
    // between them and the child — the same flag a results campaign audience
    // uses, so the two cannot disagree about who hears about a report card.
    const links = await prisma.studentGuardian.findMany({
      where: {
        studentId: { in: studentIds },
        receivesReports: true,
        guardian: { deletedAt: null },
      },
      select: {
        student: { select: { id: true, firstName: true, lastName: true } },
        guardian: { select: { id: true, firstName: true, lastName: true, phone: true } },
      },
    });

    const outgoing = links
      .map((link) => {
        const toPhone = normalisePhone(link.guardian.phone);
        if (!toPhone) {
          return null;
        }
        const body = renderTemplate(source, {
          school_name: args.schoolName,
          guardian_name: `${link.guardian.firstName} ${link.guardian.lastName}`,
          student_name: `${link.student.firstName} ${link.student.lastName}`,
          term: term ? `${termLabel(term.name)} Term` : "",
        });
        const { segments } = countSegments(body);
        return {
          schoolId: args.schoolId,
          channel: "SMS" as const,
          toPhone,
          body,
          studentId: link.student.id,
          guardianId: link.guardian.id,
          provider: settings.smsProvider,
          status: "QUEUED" as const,
          segments,
          cost: new Prisma.Decimal((segments * RATE_PER_SEGMENT).toFixed(4)),
        };
      })
      .filter((row) => row !== null);

    if (outgoing.length === 0) {
      return { texted: 0 };
    }

    // The rows THIS call created, by id. Reading back "everything still queued for
    // these pupils" also swept up messages a campaign running at the same moment
    // had queued, sending them here and again from the campaign.
    const queued = await prisma.message.createManyAndReturn({
      data: outgoing,
      select: { id: true, toPhone: true, body: true },
    });

    const sentIds: string[] = [];
    const dryIds: string[] = [];
    const failures: { id: string; error: string }[] = [];

    for (const message of queued) {
      const result = await sendSms(message.toPhone!, message.body, {
        provider: settings.smsProvider,
        senderId: settings.smsSenderId,
      });
      if (result.dryRun) {
        dryIds.push(message.id);
      } else if (result.ok) {
        sentIds.push(message.id);
      } else {
        failures.push({ id: message.id, error: result.error ?? "the text failed" });
      }
    }

    const now = new Date();
    if (sentIds.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: sentIds } },
        data: { status: "SENT", sentAt: now, error: null },
      });
    }
    if (dryIds.length > 0) {
      await prisma.message.updateMany({
        where: { id: { in: dryIds } },
        data: { status: "SENT", sentAt: now, error: "Dry run — no gateway configured" },
      });
    }
    // One at a time only for the ones that actually failed: each carries its own
    // reason, and a school with a broken gateway needs to read them.
    for (const failure of failures) {
      await prisma.message.update({
        where: { id: failure.id },
        data: { status: "FAILED", error: failure.error },
      });
    }

    return { texted: sentIds.length + dryIds.length };
  } catch {
    // Best-effort, like every other text: the results are published either way.
    return { texted: 0 };
  }
}
