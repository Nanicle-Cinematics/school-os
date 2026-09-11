"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Plan, type SubscriptionStatus } from "@prisma/client";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { slugify } from "@/lib/platform-data";
import { provisionSchool, PROVISION_TX_OPTS } from "@/lib/provisioning";
import { writeAudit } from "@/lib/audit";
import { subscriptionState, STATUS_LABELS, PLANS as PLANS_LABELS } from "@/lib/subscription";

export type PlatformState = { error?: string; ok?: string };

const PLANS: Plan[] = ["TRIAL", "STARTER", "GROWTH", "SCHOOL_PLUS"];

export async function createSchool(
  _prev: PlatformState,
  formData: FormData,
): Promise<PlatformState> {
  const admin = await requirePlatformAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const slugInput = String(formData.get("slug") ?? "").trim();
  const shortName = String(formData.get("shortName") ?? "").trim();
  const plan = String(formData.get("plan") ?? "TRIAL") as Plan;
  const weighting = String(formData.get("weighting") ?? "50");

  const ownerName = String(formData.get("ownerName") ?? "").trim();
  const ownerEmail = String(formData.get("ownerEmail") ?? "").trim().toLowerCase();

  if (!name) {
    return { error: "Name the school as it should appear on a report card." };
  }
  if (!PLANS.includes(plan)) {
    return { error: "Pick a plan." };
  }
  if (!ownerName || !ownerEmail) {
    return { error: "The proprietor needs a name and an email address to sign in with." };
  }

  const slug = slugify(slugInput || name);
  if (!slug) {
    return { error: "That name produces an empty URL key — set one by hand." };
  }

  // 50/50 is the basic-school convention, 30/70 SHS. Getting this wrong rescales
  // every mark in the school, so it is asked at provisioning rather than left
  // to a default the head may never look at.
  const classScoreWeight = weighting === "30" ? 30 : 50;

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  try {
    await withBypass(() =>
      prisma.$transaction(
        (tx) =>
          provisionSchool(tx, {
            name,
            slug,
            shortName: shortName || null,
            plan,
            classScoreWeight,
            ownerName,
            ownerEmail,
            passwordHash,
            actorUserId: admin.userId,
          }),
        PROVISION_TX_OPTS,
      ),
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = String((error.meta?.target as string[] | undefined)?.join(", ") ?? "");
      if (target.includes("email")) {
        return { error: `${ownerEmail} already has a login on the platform.` };
      }
      return { error: `The URL key "${slug}" is taken — choose another.` };
    }
    throw error;
  }

  revalidatePath("/admin");
  return {
    ok: `${name} is ready, with the GES curriculum already set up — KG1 to JHS 3 and the subjects each level offers. ${ownerName} signs in with ${ownerEmail} and the temporary password ${password} — hand it over now, it is not shown again. Next they add an academic year and their classes.`,
  };
}

const STATUSES: SubscriptionStatus[] = [
  "TRIALING",
  "ACTIVE",
  "PAST_DUE",
  "SUSPENDED",
  "CANCELLED",
];

/**
 * Change what a school is paying for, and what that lets it do.
 *
 * ⚠️ `withBypass` is not optional here. The console is changing the very field
 * that decides whether a school may be written to, so without it the action that
 * REACTIVATES a suspended school would be refused by the suspension — and the
 * only way out would be the database.
 *
 * Audited to the school's own trail, so a head teacher asking "why did this go
 * read-only in March" has an answer that is not somebody's memory.
 */
export async function updateSubscription(
  _prev: PlatformState,
  formData: FormData,
): Promise<PlatformState> {
  const admin = await requirePlatformAdmin();

  const schoolId = String(formData.get("schoolId") ?? "");
  const plan = String(formData.get("plan") ?? "") as Plan;
  const status = String(formData.get("subscriptionStatus") ?? "") as SubscriptionStatus;
  const capRaw = String(formData.get("studentCap") ?? "").trim();
  const trialRaw = String(formData.get("trialEndsAt") ?? "").trim();

  if (!schoolId) {
    return { error: "Which school?" };
  }
  if (!PLANS.includes(plan)) {
    return { error: "Unknown plan." };
  }
  if (!STATUSES.includes(status)) {
    return { error: "Unknown subscription status." };
  }

  // An empty cap means "no cap" — School Plus. A zero would lock the school out
  // of admitting anyone, which is never what someone typing 0 means.
  const studentCap = capRaw === "" ? null : Number(capRaw);
  if (studentCap !== null && (!Number.isInteger(studentCap) || studentCap < 1)) {
    return { error: "A pupil cap is a whole number, or blank for no cap." };
  }

  const trialEndsAt = trialRaw === "" ? null : new Date(trialRaw);
  if (trialEndsAt && Number.isNaN(trialEndsAt.getTime())) {
    return { error: "That trial end date could not be read." };
  }

  const before = await withBypass(() =>
    prisma.school.findUnique({
      where: { id: schoolId },
      select: { name: true, plan: true, subscriptionStatus: true, studentCap: true, trialEndsAt: true },
    }),
  );
  if (!before) {
    return { error: "That school no longer exists." };
  }

  await withBypass(async () => {
    await prisma.school.update({
      where: { id: schoolId },
      data: { plan, subscriptionStatus: status, studentCap, trialEndsAt },
    });
    await writeAudit(prisma, {
      schoolId,
      actorUserId: admin.userId,
      action: "school.subscription",
      entity: "School",
      entityId: schoolId,
      before,
      after: { plan, subscriptionStatus: status, studentCap, trialEndsAt },
    });
  });

  revalidatePath("/admin");
  revalidatePath(`/admin/${schoolId}`);
  // The banner and the read-only rule are resolved per request from this row, so
  // every signed-in session at that school picks the change up on its next page.
  revalidatePath("/", "layout");

  const state = subscriptionState({ plan, subscriptionStatus: status, trialEndsAt });
  return {
    ok: `${before.name} is now ${STATUS_LABELS[status]} on ${PLANS_LABELS[plan].label}${
      state.readOnly ? " — staff can read and print, but not enter anything new." : "."
    }`,
  };
}
