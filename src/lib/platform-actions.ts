"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Plan } from "@prisma/client";
import { requirePlatformAdmin } from "@/lib/platform-auth";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { hashPassword, temporaryPassword } from "@/lib/password";
import { writeAudit } from "@/lib/audit";
import { slugify } from "@/lib/platform-data";

export type PlatformState = { error?: string; ok?: string };

const PLANS: Plan[] = ["TRIAL", "STARTER", "GROWTH", "SCHOOL_PLUS"];

/**
 * The Ghanaian basic-school scale, as a starting point.
 *
 * A school with no grading scale cannot compute a single result, so provisioning
 * one without it hands over an app that looks finished and fails at the first
 * report card. The head can edit the bands, or duplicate and replace it.
 */
const DEFAULT_BANDS = [
  { grade: "1", minScore: 80, maxScore: 100, points: 1, remark: "Excellent", isPass: true },
  { grade: "2", minScore: 70, maxScore: 79.99, points: 2, remark: "Very Good", isPass: true },
  { grade: "3", minScore: 65, maxScore: 69.99, points: 3, remark: "Good", isPass: true },
  { grade: "4", minScore: 60, maxScore: 64.99, points: 4, remark: "Credit", isPass: true },
  { grade: "5", minScore: 55, maxScore: 59.99, points: 5, remark: "Credit", isPass: true },
  { grade: "6", minScore: 50, maxScore: 54.99, points: 6, remark: "Credit", isPass: true },
  { grade: "7", minScore: 45, maxScore: 49.99, points: 7, remark: "Pass", isPass: true },
  { grade: "8", minScore: 40, maxScore: 44.99, points: 8, remark: "Pass", isPass: true },
  { grade: "9", minScore: 0, maxScore: 39.99, points: 9, remark: "Fail", isPass: false },
];

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
  const examScoreWeight = 100 - classScoreWeight;

  const password = temporaryPassword();
  const passwordHash = await hashPassword(password);

  try {
    await withBypass(() =>
      prisma.$transaction(
        async (tx) => {
          const school = await tx.school.create({
            data: {
              name,
              slug,
              shortName: shortName || null,
              plan,
              subscriptionStatus: plan === "TRIAL" ? "TRIALING" : "ACTIVE",
              trialEndsAt:
                plan === "TRIAL" ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null,
            },
          });

          const scale = await tx.gradingScale.create({
            data: { schoolId: school.id, name: "Basic School 1–9", isDefault: true },
          });
          await tx.gradeBand.createMany({
            data: DEFAULT_BANDS.map((band) => ({
              schoolId: school.id,
              gradingScaleId: scale.id,
              grade: band.grade,
              minScore: new Prisma.Decimal(band.minScore),
              maxScore: new Prisma.Decimal(band.maxScore),
              points: band.points,
              remark: band.remark,
              isPass: band.isPass,
            })),
          });

          await tx.schoolSettings.create({
            data: {
              schoolId: school.id,
              classScoreWeight,
              examScoreWeight,
              defaultGradingScaleId: scale.id,
            },
          });

          const owner = await tx.user.create({
            data: {
              name: ownerName,
              email: ownerEmail,
              passwordHash,
              schoolId: school.id,
            },
          });

          await tx.membership.create({
            data: {
              schoolId: school.id,
              userId: owner.id,
              role: "OWNER",
              status: "ACTIVE",
              invitedAt: new Date(),
              acceptedAt: new Date(),
            },
          });

          await writeAudit(tx, {
            schoolId: school.id,
            actorUserId: admin.userId,
            action: "school.provision",
            entity: "School",
            entityId: school.id,
            after: { name, slug, plan, classScoreWeight, owner: ownerEmail },
          });
        },
        { timeout: 60_000, maxWait: 15_000 },
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
    ok: `${name} is ready. ${ownerName} signs in with ${ownerEmail} and the temporary password ${password} — hand it over now, it is not shown again. They still need levels, classes and subjects before admitting anyone.`,
  };
}
