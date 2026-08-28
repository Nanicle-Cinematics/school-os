"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Plan } from "@prisma/client";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { slugify } from "@/lib/platform-data";
import { provisionSchool, PROVISION_TX_OPTS } from "@/lib/provisioning";

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
