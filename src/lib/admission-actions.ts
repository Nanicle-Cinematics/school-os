"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ApplicationStatus } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { ADMISSIONS, ADMISSIONS_FORM } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { writeAudit } from "@/lib/audit";
import {
  admitApplication,
  createApplication,
  deleteApplication,
  moveApplication,
  recordTest,
  updateApplication,
} from "@/lib/admissions-engine";
import {
  LIMITS,
  STATUS_ORDER,
  readApplication,
  readDecisionNote,
  readOfferExpiry,
  readTest,
} from "@/lib/admissions-rules";

/**
 * The office's side of admissions. Every action runs `requireRole`, sets the tenant context in its own frame
 * (a context set inside `requireRole` does not reach here) and hands the real work to the engine.
 *
 * A refusal hands back what was typed (`values`): React resets a form when its action returns, and one bad
 * date must not cost a clerk the rest of an application they were typing from a paper form.
 */

export type AdmissionState = {
  error?: string;
  ok?: string;
  values?: Record<string, string>;
  /** Set when an admission succeeded, so the page can link to the new pupil. */
  studentId?: string;
};

const FIELDS = [
  "firstName", "middleName", "lastName", "gender", "dateOfBirth", "previousSchool", "notes",
  "guardianName", "guardianPhone", "guardianEmail", "guardianRelationship", "levelId", "academicYearId",
] as const;

function pick(formData: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, String(formData.get(key) ?? "")]));
}

export async function createApplicationAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const values = pick(formData, FIELDS);
  const read = readApplication(values);
  if (!read.ok) return { error: read.error, values };

  const made = await createApplication({ schoolId: auth.schoolId, userId: auth.userId }, read.value, "OFFICE");
  if ("error" in made) return { error: made.error, values };

  revalidatePath("/admissions");
  revalidatePath("/dashboard");
  redirect(`/admissions/${made.id}`);
}

export async function saveApplicationAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const values = pick(formData, FIELDS);
  const read = readApplication(values);
  if (!read.ok) return { error: read.error, values };

  const done = await updateApplication({ schoolId: auth.schoolId, userId: auth.userId }, id, read.value);
  if ("error" in done) return { error: done.error, values };

  revalidatePath("/admissions");
  revalidatePath(`/admissions/${id}`);
  redirect(`/admissions/${id}`);
}

export async function recordTestAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const values = pick(formData, ["testedOn", "testScore", "testNotes"]);
  const read = readTest(values);
  if (!read.ok) return { error: read.error, values };

  const done = await recordTest({ schoolId: auth.schoolId, userId: auth.userId }, id, read);
  if ("error" in done) return { error: done.error, values };

  revalidatePath("/admissions");
  revalidatePath(`/admissions/${id}`);
  return { ok: done.ok };
}

/** Offer a place, accept, waitlist, reject, withdraw or reopen: one action, the engine decides what is allowed. */
export async function moveApplicationAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const to = String(formData.get("to") ?? "") as ApplicationStatus;
  if (!STATUS_ORDER.includes(to)) return { error: "That is not a step an application can take." };

  const expiry = readOfferExpiry(String(formData.get("offerExpiresOn") ?? ""));
  if (!expiry.ok) return { error: expiry.error };
  const note = readDecisionNote(String(formData.get("note") ?? ""));
  if (!note.ok) return { error: note.error };

  const done = await moveApplication(
    { schoolId: auth.schoolId, userId: auth.userId },
    id,
    to,
    { offerExpiresOn: expiry.value, note: note.value },
  );
  if ("error" in done) return { error: done.error };

  revalidatePath("/admissions");
  revalidatePath(`/admissions/${id}`);
  revalidatePath("/dashboard");
  return { ok: done.ok };
}

export async function admitApplicationAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const done = await admitApplication(
    { schoolId: auth.schoolId, userId: auth.userId },
    id,
    String(formData.get("classGroupId") ?? ""),
  );
  if ("error" in done) return { error: done.error };

  revalidatePath("/admissions");
  revalidatePath(`/admissions/${id}`);
  revalidatePath("/students");
  revalidatePath("/dashboard");
  return { ok: done.ok, studentId: done.studentId };
}

export async function deleteApplicationAction(formData: FormData): Promise<void> {
  const auth = await requireRole(ADMISSIONS);
  setTenantContext(auth.tenant);

  const done = await deleteApplication({ schoolId: auth.schoolId, userId: auth.userId }, String(formData.get("id") ?? ""));
  revalidatePath("/admissions");
  if ("error" in done) {
    redirect(`/admissions/${String(formData.get("id") ?? "")}`);
  }
  redirect("/admissions");
}

/**
 * Open or close the public application form, and write the note shown above it.
 *
 * Leadership only. Two buttons rather than a tick-box: a controlled checkbox is reset by React when the
 * action returns (see the mark sheet), and a label that followed it would then lie.
 */
export async function saveApplicationFormAction(_prev: AdmissionState, formData: FormData): Promise<AdmissionState> {
  const auth = await requireRole(ADMISSIONS_FORM);
  setTenantContext(auth.tenant);

  const open = String(formData.get("open") ?? "") === "1";
  const raw = String(formData.get("note") ?? "").replace(/\r\n?/g, "\n").trim();
  if (raw.length > LIMITS.intro) return { error: `The note is too long (at most ${LIMITS.intro} characters).`, values: { note: raw } };

  if (open) {
    const levels = await prisma.level.count();
    const years = await prisma.academicYear.count({ where: { endDate: { gte: new Date() } } });
    if (levels === 0 || years === 0) {
      return { error: "Set up the school's classes and academic year first: the form has nothing to offer a parent yet.", values: { note: raw } };
    }
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.schoolSettings.upsert({
      where: { schoolId: auth.schoolId },
      create: { schoolId: auth.schoolId, applicationsOpen: open, applicationsNote: raw || null },
      update: { applicationsOpen: open, applicationsNote: raw || null },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "application.form",
      entity: "School",
      entityId: auth.schoolId,
      after: { open },
    });
  });

  revalidatePath("/admissions");
  return { ok: open ? "The online form is open." : "The online form is closed." };
}
