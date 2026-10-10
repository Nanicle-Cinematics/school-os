"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type GradingState = { error?: string; ok?: string };

function refresh() {
  revalidatePath("/settings/grading");
  revalidatePath("/settings");
  revalidatePath("/results");
}

function duplicate(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

const SCALE_NOT_FOUND = "That grading scale was not found.";

/**
 * Whether the scale is one of this school's own.
 *
 * ⚠️ Run this BEFORE `assertEditable`. Under row security another school's scale
 * reads as absent, so its result count is 0 and the freeze guard concludes
 * nothing is in the way. A foreign key check ignores row security, and the band
 * carries the caller's own `schoolId`, so the insert would then pass the
 * policy's WITH CHECK as well. Adding `schoolId` to the later reads does not
 * help for the same reason: they would simply find nothing.
 */
async function ownsScale(gradingScaleId: string): Promise<boolean> {
  const scale = await prisma.gradingScale.findFirst({
    where: { id: gradingScaleId },
    select: { id: true },
  });
  return scale !== null;
}

/** Bands may only be touched while nothing has been graded against the scale. */
async function assertEditable(gradingScaleId: string): Promise<string | null> {
  const used = await prisma.subjectResult.count({ where: { gradingScaleId } });
  if (used > 0) {
    return `This scale has already graded ${used} result${
      used === 1 ? "" : "s"
    }. Duplicate it and edit the copy — changing a boundary now would rewrite report cards that are already out.`;
  }
  return null;
}

export async function saveScale(_prev: GradingState, formData: FormData): Promise<GradingState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const makeDefault = formData.get("isDefault") === "on";

  if (!name) {
    return { error: "Give the scale a name, e.g. Basic School 1–9." };
  }

  if (id && !(await ownsScale(id))) {
    return { error: SCALE_NOT_FOUND };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const scale = id
        ? await tx.gradingScale.update({ where: { id }, data: { name } })
        : await tx.gradingScale.create({ data: { schoolId: auth.schoolId, name } });

      if (makeDefault) {
        // Two places record "the default": GradingScale.isDefault, which is
        // decorative, and SchoolSettings.defaultGradingScaleId, which is what
        // results-engine actually reads. Write both or they drift apart and the
        // screen disagrees with the marks.
        await tx.gradingScale.updateMany({
          where: { isDefault: true },
          data: { isDefault: false },
        });
        await tx.gradingScale.update({ where: { id: scale.id }, data: { isDefault: true } });
        await tx.schoolSettings.upsert({
          where: { schoolId: auth.schoolId },
          create: { schoolId: auth.schoolId, defaultGradingScaleId: scale.id },
          update: { defaultGradingScaleId: scale.id },
        });
      }

    });

    refresh();
    return { ok: makeDefault ? `${name} saved and set as the default.` : `${name} saved.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `There is already a scale called ${name}.` };
    }
    throw error;
  }
}

/**
 * Copy a frozen scale so its successor can be edited.
 *
 * This is the supported way to change grading policy: the old scale stays
 * attached to the results it graded, and next term's results are computed
 * against the copy.
 */
export async function duplicateScale(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const source = await prisma.gradingScale.findUnique({
    where: { id },
    include: { bands: true },
  });
  if (!source) {
    return;
  }

  // "X (copy)", "X (copy 2)" … so repeated duplication does not collide.
  const existing = await prisma.gradingScale.count({
    where: { name: { startsWith: `${source.name} (copy` } },
  });
  const name = existing === 0 ? `${source.name} (copy)` : `${source.name} (copy ${existing + 1})`;

  await tenantTransaction(auth.schoolId, async (tx) => {
    const copy = await tx.gradingScale.create({
      data: { schoolId: auth.schoolId, name },
    });

    if (source.bands.length > 0) {
      await tx.gradeBand.createMany({
        data: source.bands.map((band) => ({
          schoolId: auth.schoolId,
          gradingScaleId: copy.id,
          grade: band.grade,
          minScore: band.minScore,
          maxScore: band.maxScore,
          points: band.points,
          remark: band.remark,
          isPass: band.isPass,
        })),
      });
    }
  });

  refresh();
}

export async function deleteScale(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  if (!(await ownsScale(id))) {
    return;
  }

  const used = await prisma.subjectResult.count({ where: { gradingScaleId: id } });
  if (used > 0) {
    return;
  }

  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId: auth.schoolId },
    select: { defaultGradingScaleId: true },
  });
  // Deleting the default would leave results computation with no scale at all.
  if (settings?.defaultGradingScaleId === id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.gradingScale.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "gradingScale.delete",
      entity: "GradingScale",
      entityId: id,
    });
  });
  refresh();
}

export async function saveBand(_prev: GradingState, formData: FormData): Promise<GradingState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const gradingScaleId = String(formData.get("gradingScaleId") ?? "");
  const id = String(formData.get("id") ?? "");
  const grade = String(formData.get("grade") ?? "").trim().toUpperCase();
  const remark = String(formData.get("remark") ?? "").trim();
  const minScore = Number(formData.get("minScore"));
  const maxScore = Number(formData.get("maxScore"));
  const points = Number(formData.get("points"));
  const isPass = formData.get("isPass") === "on";

  if (!gradingScaleId) {
    return { error: "Missing scale." };
  }

  if (!(await ownsScale(gradingScaleId))) {
    return { error: SCALE_NOT_FOUND };
  }

  // An edited band must hang on the scale it was posted with, or the update
  // could move a band, or be checked against the wrong scale's freeze.
  if (id) {
    const band = await prisma.gradeBand.findFirst({
      where: { id, gradingScaleId },
      select: { id: true },
    });
    if (!band) {
      return { error: "That band was not found on this scale." };
    }
  }

  const frozen = await assertEditable(gradingScaleId);
  if (frozen) {
    return { error: frozen };
  }

  if (!grade) {
    return { error: "Give the band a grade, e.g. A1 or 3." };
  }
  if (!remark) {
    return { error: "Give the band a remark — it is what prints on the report card." };
  }
  if (!Number.isFinite(minScore) || !Number.isFinite(maxScore)) {
    return { error: "Enter both score boundaries." };
  }
  if (minScore < 0 || maxScore > 100) {
    return { error: "Boundaries must sit between 0 and 100." };
  }
  if (minScore > maxScore) {
    return { error: "The lower boundary cannot be above the upper one." };
  }
  if (!Number.isFinite(points) || points < 0) {
    return { error: "Points must be zero or more — A1 = 1 up to F9 = 9." };
  }

  // Overlapping bands make the grade a child receives depend on row order.
  const siblings = await prisma.gradeBand.findMany({
    where: { gradingScaleId, ...(id ? { id: { not: id } } : {}) },
  });
  const clash = siblings.find(
    (band) => minScore <= Number(band.maxScore) && maxScore >= Number(band.minScore),
  );
  if (clash) {
    return {
      error: `That range overlaps ${clash.grade} (${clash.minScore}–${clash.maxScore}).`,
    };
  }

  const data = {
    grade,
    remark,
    minScore: new Prisma.Decimal(minScore),
    maxScore: new Prisma.Decimal(maxScore),
    points: Math.trunc(points),
    isPass,
  };

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const band = id
        ? await tx.gradeBand.update({ where: { id }, data })
        : await tx.gradeBand.create({
            data: { schoolId: auth.schoolId, gradingScaleId, ...data },
          });

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: id ? "grade-band.update" : "grade-band.create",
        entity: "GradeBand",
        entityId: band.id,
        after: { grade, minScore, maxScore, points, isPass },
      });
    });
  } catch (error) {
    if (duplicate(error)) {
      return { error: `This scale already has a band called ${grade}.` };
    }
    throw error;
  }

  refresh();
  return { ok: `Saved ${grade}.` };
}

export async function deleteBand(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  const gradingScaleId = String(formData.get("gradingScaleId") ?? "");
  if (!id || !gradingScaleId) {
    return;
  }

  if (!(await ownsScale(gradingScaleId))) {
    return;
  }
  const band = await prisma.gradeBand.findFirst({
    where: { id, gradingScaleId },
    select: { id: true },
  });
  if (!band) {
    return;
  }

  if (await assertEditable(gradingScaleId)) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.gradeBand.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "gradeBand.delete",
      entity: "GradeBand",
      entityId: id,
    });
  });
  refresh();
}
