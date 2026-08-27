"use server";

import { revalidatePath } from "next/cache";
import type { SmsProvider } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

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
    reportCardTemplate: String(formData.get("reportCardTemplate") ?? "ges_standard"),
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

  await upsertSettings(auth.schoolId, {
    invoiceDueDays: Math.trunc(invoiceDueDays),
    blockReportOnArrears: formData.get("blockReportOnArrears") === "on",
    // Empty means "print nothing", not "an empty box".
    paymentInstructions: paymentInstructions || null,
    invoiceNote: invoiceNote || null,
  });

  revalidatePath("/settings");
  revalidatePath("/invoices");
  return { ok: "Fees policy saved." };
}

export async function saveSmsSettings(
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const smsEnabled = formData.get("smsEnabled") === "on";
  const providerRaw = String(formData.get("smsProvider") ?? "");
  const smsSenderId = String(formData.get("smsSenderId") ?? "").trim();

  if (providerRaw && !PROVIDERS.includes(providerRaw as SmsProvider)) {
    return { error: "Unknown SMS provider." };
  }
  if (smsEnabled && !providerRaw) {
    return { error: "Pick a provider before turning SMS on." };
  }
  // Ghanaian gateways reject an alphanumeric sender longer than 11 characters,
  // and the rejection arrives per message, after the school has been billed.
  if (smsSenderId.length > 11) {
    return { error: "Sender ID can be at most 11 characters." };
  }

  await upsertSettings(auth.schoolId, {
    smsEnabled,
    smsProvider: providerRaw ? (providerRaw as SmsProvider) : null,
    smsSenderId: smsSenderId || null,
    notifyOnPayment: formData.get("notifyOnPayment") === "on",
    notifyOnResultPublish: formData.get("notifyOnResultPublish") === "on",
  });

  revalidatePath("/settings");
  revalidatePath("/messages");
  return { ok: smsEnabled ? "SMS is on." : "SMS saved — sending stays off." };
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
