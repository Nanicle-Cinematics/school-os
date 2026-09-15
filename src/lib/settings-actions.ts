"use server";

import { revalidatePath } from "next/cache";
import type { SmsProvider } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { parseAmount } from "@/lib/money";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE, TECHNICAL } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { Prisma } from "@prisma/client";
import { sendSms, normalisePhone, countSegments, RATE_PER_SEGMENT } from "@/lib/sms";
import { localPhone } from "@/lib/portal-invite-data";

export type SettingsState = { error?: string; ok?: string };

const PROVIDERS: SmsProvider[] = ["ARKESEL", "HUBTEL", "MNOTIFY"];

/** Every settings form writes through here — SchoolSettings may not exist yet. */
async function upsertSettings(schoolId: string, data: Record<string, unknown>) {
  return prisma.schoolSettings.upsert({
    where: { schoolId },
    create: { schoolId, ...data },
    update: data,
  });
}

export async function saveSchoolProfile(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const name = String(formData.get("name") ?? "").trim();
  if (!name) {
    return { error: "The school needs a name — it heads every report card and receipt." };
  }

  const text = (key: string) => String(formData.get(key) ?? "").trim() || null;

  await prisma.school.update({
    where: { id: auth.schoolId },
    data: {
      name,
      shortName: text("shortName"),
      motto: text("motto"),
      headName: text("headName"),
      email: text("email"),
      phone: text("phone"),
      altPhone: text("altPhone"),
      website: text("website"),
      address: text("address"),
      town: text("town"),
      district: text("district"),
      region: text("region"),
      gpsAddress: text("gpsAddress"),
      accreditationNo: text("accreditationNo"),
    },
  });

  revalidatePath("/settings");
  revalidatePath("/dashboard");
  return { ok: "School profile saved." };
}

export async function saveAcademicPolicy(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const classScoreWeight = Number(formData.get("classScoreWeight"));
  const examScoreWeight = Number(formData.get("examScoreWeight"));
  const aggregateSubjects = Number(formData.get("aggregateSubjects"));
  const defaultGradingScaleId = String(formData.get("defaultGradingScaleId") ?? "");

  if (!Number.isFinite(classScoreWeight) || !Number.isFinite(examScoreWeight)) {
    return { error: "Weights must be numbers." };
  }
  // The two weights are what every computed result is built from; letting them
  // sum to anything but 100 would quietly rescale every mark in the school.
  if (classScoreWeight + examScoreWeight !== 100) {
    return {
      error: `Class and exam weights must add up to 100 — they currently make ${
        classScoreWeight + examScoreWeight
      }.`,
    };
  }
  if (!Number.isFinite(aggregateSubjects) || aggregateSubjects < 1) {
    return { error: "Aggregate needs at least one subject (BECE uses 6)." };
  }

  const data = {
    classScoreWeight: Math.trunc(classScoreWeight),
    examScoreWeight: Math.trunc(examScoreWeight),
    aggregateSubjects: Math.trunc(aggregateSubjects),
    defaultGradingScaleId: defaultGradingScaleId || null,
    showClassPosition: formData.get("showClassPosition") === "on",
    showSubjectPosition: formData.get("showSubjectPosition") === "on",
    showAggregate: formData.get("showAggregate") === "on",
  };

  const before = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });

  await tenantTransaction(auth.schoolId, async (tx) => {
    const settings = await tx.schoolSettings.upsert({
      where: { schoolId: auth.schoolId },
      create: { schoolId: auth.schoolId, ...data },
      update: data,
    });

    // Grading policy changes what a mark means, so it is audited like money.
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "settings.academic",
      entity: "SchoolSettings",
      entityId: settings.id,
      before: before
        ? {
            classScoreWeight: before.classScoreWeight,
            examScoreWeight: before.examScoreWeight,
            aggregateSubjects: before.aggregateSubjects,
            defaultGradingScaleId: before.defaultGradingScaleId,
          }
        : null,
      after: data,
    });
  });

  revalidatePath("/settings");
  revalidatePath("/results");
  return {
    ok: `Saved. ${data.classScoreWeight}% class score, ${data.examScoreWeight}% exam — takes effect the next time results are computed.`,
  };
}

export async function saveFeesPolicy(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const invoiceDueDays = Number(formData.get("invoiceDueDays"));
  if (!Number.isFinite(invoiceDueDays) || invoiceDueDays < 0) {
    return { error: "Days until due must be zero or more." };
  }

  const paymentInstructions = String(formData.get("paymentInstructions") ?? "").trim();
  const invoiceNote = String(formData.get("invoiceNote") ?? "").trim();

  if (paymentInstructions.length > 600) {
    return { error: "Keep the payment details under 600 characters — they share a page with the bill." };
  }
  if (invoiceNote.length > 200) {
    return { error: "Keep the note under 200 characters — it prints as one line." };
  }

  /**
   * Blank means "we do not want approvals", which is NOT the same as zero.
   * Zero would hold every voucher in the school, chalk included, and the first
   * bursar to meet that would stop using the cash book. parseAmount refuses
   * zero and negatives already, so the only way to say "off" is to empty the
   * box — and that has to reach the column as NULL rather than as 0.
   */
  const thresholdRaw = String(formData.get("expenseApprovalThreshold") ?? "").trim();
  const expenseApprovalThreshold = thresholdRaw ? parseAmount(thresholdRaw) : null;
  if (thresholdRaw && !expenseApprovalThreshold) {
    return { error: "The approval threshold must be an amount greater than zero, or empty for none." };
  }

  await upsertSettings(auth.schoolId, {
    invoiceDueDays: Math.trunc(invoiceDueDays),
    blockReportOnArrears: formData.get("blockReportOnArrears") === "on",
    expenseApprovalThreshold,
    // Empty means "print nothing", not "an empty box".
    paymentInstructions: paymentInstructions || null,
    invoiceNote: invoiceNote || null,
  });

  revalidatePath("/settings");
  revalidatePath("/invoices");
  revalidatePath("/expenses");
  return { ok: "Fees policy saved." };
}

/**
 * The gateway wiring: which provider, which sender ID.
 *
 * TECHNICAL, so an IT admin can set it up without also being handed the fees
 * policy. Deliberately does NOT touch smsEnabled or the notify gates — see
 * saveSmsPolicy, and the note on TECHNICAL for why the line falls here.
 */
export async function saveSmsGateway(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(TECHNICAL);
  setTenantContext({ schoolId: auth.schoolId });

  const providerRaw = String(formData.get("smsProvider") ?? "");
  const smsSenderId = String(formData.get("smsSenderId") ?? "").trim();

  if (providerRaw && !PROVIDERS.includes(providerRaw as SmsProvider)) {
    return { error: "Unknown SMS provider." };
  }
  // Ghanaian gateways reject an alphanumeric sender longer than 11 characters,
  // and the rejection arrives per message, after the school has been billed.
  if (smsSenderId.length > 11) {
    return { error: "Sender ID can be at most 11 characters." };
  }

  /**
   * ⚠️ Clearing the provider while sending is ON is refused.
   *
   * The two halves of this setting now live on two screens with two different
   * audiences, so each has to defend the invariant the other used to hold for
   * free: SMS cannot be enabled with nothing behind it. Without this, an IT
   * admin tidying up a provider field would leave the school "sending" into
   * a gateway that is not there — and every text would dry-run silently, which
   * is the failure this codebase already knows nobody notices.
   */
  if (!providerRaw) {
    const current = await prisma.schoolSettings.findUnique({
      where: { schoolId: auth.schoolId },
      select: { smsEnabled: true },
    });
    if (current?.smsEnabled) {
      return {
        error:
          "SMS is switched on, so it needs a provider. Ask the head to turn sending off first, or pick a provider.",
      };
    }
  }

  await upsertSettings(auth.schoolId, {
    smsProvider: providerRaw ? (providerRaw as SmsProvider) : null,
    smsSenderId: smsSenderId || null,
  });

  revalidatePath("/settings");
  revalidatePath("/settings/sms");
  revalidatePath("/messages");
  return { ok: "Gateway saved." };
}

/**
 * Whether the school texts parents at all, and what triggers one.
 *
 * OFFICE, not TECHNICAL: every message costs the school money, so turning
 * sending on is the proprietor's decision and not the helpdesk's.
 */
export async function saveSmsPolicy(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const smsEnabled = formData.get("smsEnabled") === "on";

  // The mirror of the refusal in saveSmsGateway. Turning sending on with no
  // gateway configured would bill nobody and deliver nothing.
  if (smsEnabled) {
    const current = await prisma.schoolSettings.findUnique({
      where: { schoolId: auth.schoolId },
      select: { smsProvider: true },
    });
    if (!current?.smsProvider) {
      return {
        error:
          "No SMS gateway is configured yet, so nothing would be delivered. Set the provider under Settings → SMS gateway first.",
      };
    }
  }

  await upsertSettings(auth.schoolId, {
    smsEnabled,
    notifyOnPayment: formData.get("notifyOnPayment") === "on",
    notifyOnResultPublish: formData.get("notifyOnResultPublish") === "on",
  });

  revalidatePath("/settings");
  revalidatePath("/messages");
  return { ok: smsEnabled ? "SMS is on." : "Saved — sending stays off." };
}

/**
 * Point the whole app at a different term.
 *
 * Nearly every page reads "the current term" rather than taking one as a
 * parameter, so this single flag decides which term invoices, score entry and
 * the dashboard are talking about. The term's year is promoted with it — a
 * current term inside a non-current year would make those two disagree.
 */
export async function setCurrentTerm(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const termId = String(formData.get("termId") ?? "");
  if (!termId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const term = await tx.term.findUnique({ where: { id: termId } });
    if (!term) {
      return;
    }

    await tx.term.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    await tx.academicYear.updateMany({ where: { isCurrent: true }, data: { isCurrent: false } });
    await tx.term.update({ where: { id: termId }, data: { isCurrent: true } });
    await tx.academicYear.update({
      where: { id: term.academicYearId },
      data: { isCurrent: true },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "settings.current-term",
      entity: "Term",
      entityId: termId,
      after: { sequence: term.sequence, academicYearId: term.academicYearId },
    });
  });

  revalidatePath("/", "layout");
}

export type TestSmsState = { error?: string; ok?: string };

/**
 * Send ONE text, to a number the office types, using the school's own settings.
 *
 * ⚠️ This exists because a gateway is either configured or it is a dry run, and
 * until now the only way to learn which was to invite 43 parents and read the
 * failures afterwards. The three provider integrations had never executed once
 * against a real gateway — Arkesel's was still written against a v1 API that has
 * since been replaced — so "we set the environment variable" was never evidence
 * of anything.
 *
 * Deliberately NOT gated on `smsEnabled` or the notify switches: this is how you
 * check the wiring BEFORE turning it on for a school's parents. It is gated on
 * the same OFFICE role as the settings themselves, and it says plainly when the
 * server has no credentials and nothing left the building.
 */
export async function sendTestSms(
  _prev: TestSmsState,
  formData: FormData,
): Promise<TestSmsState> {
  // TECHNICAL: proving the wiring is the job of whoever did the wiring.
  // It is ungated by smsEnabled on purpose, so the gateway can be checked
  // BEFORE any parent hears from the school — and it costs one message,
  // which is why it is not open to everyone.
  const auth = await requireRole(TECHNICAL);
  setTenantContext({ schoolId: auth.schoolId });

  const phone = normalisePhone(String(formData.get("testPhone") ?? ""));
  if (!phone) {
    return { error: "Enter a Ghana mobile number, e.g. 0244000000." };
  }

  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });
  const body =
    `${auth.schoolName}: this is a test message from School OS. ` +
    `If you received it, texts to parents will work.`;

  const result = await sendSms(phone, body, {
    provider: settings?.smsProvider,
    senderId: settings?.smsSenderId,
  });

  // A test costs the school a message like any other, so it belongs in the log
  // the Messages screen totals its spend from. Recorded only when something
  // actually left — a dry run spends nothing.
  if (!result.dryRun) {
    const { segments } = countSegments(body);
    await prisma.message.create({
      data: {
        schoolId: auth.schoolId,
        channel: "SMS",
        toPhone: phone,
        body,
        provider: settings?.smsProvider ?? null,
        status: result.ok ? "SENT" : "FAILED",
        providerRef: result.providerRef ?? null,
        error: result.error ?? null,
        sentAt: result.ok ? new Date() : null,
        segments,
        cost: new Prisma.Decimal((segments * RATE_PER_SEGMENT).toFixed(4)),
      },
    });
  }

  if (result.dryRun) {
    return {
      error:
        "No gateway is configured on the server, so nothing was sent. SMS_PROVIDER and SMS_API_KEY " +
        "have to be set where the app runs — until then every text is a dry run.",
    };
  }
  if (!result.ok) {
    // The gateway's own words: a rejected sender ID and a wrong key look
    // identical from the outside, and only the gateway knows which it was.
    return { error: `The gateway refused it — ${result.error ?? "no reason given"}` };
  }

  return {
    ok: `Sent to ${localPhone(phone)}. If it does not arrive within a minute, the sender ID is usually the reason — it must be registered with ${settings?.smsProvider ?? "the provider"}.`,
  };
}
