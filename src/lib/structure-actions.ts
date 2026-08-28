"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Stage } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { LEADERSHIP, OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { applyGesCurriculum } from "@/lib/ges-curriculum";
import { applyDefaultAssessmentTemplate } from "@/lib/assessment-templates";
import { writeAudit } from "@/lib/audit";

export type StructureState = { error?: string; ok?: string };

const STAGE_VALUES: Stage[] = [
  "CRECHE",
  "NURSERY",
  "KINDERGARTEN",
  "PRIMARY",
  "JHS",
  "SHS",
];

function duplicate(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function refresh() {
  revalidatePath("/settings/components");
  revalidatePath("/settings/structure");
  revalidatePath("/settings");
  revalidatePath("/classes");
}

export async function saveLevel(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();
  const stage = String(formData.get("stage") ?? "") as Stage;
  const orderRaw = Number(formData.get("order"));

  if (!name) {
    return { error: "Give the level a name, e.g. Basic 5." };
  }
  if (!code) {
    return { error: "Give the level a short code — it heads report-card columns." };
  }
  if (!STAGE_VALUES.includes(stage)) {
    return { error: "Pick the stage this level belongs to." };
  }
  // Order is what sorts every class list, broadsheet and fee table. Two levels
  // sharing a number is not an error, but a missing one sorts to the top and
  // makes KG appear above SHS.
  if (!Number.isFinite(orderRaw)) {
    return { error: "Order must be a number — it sorts the whole ladder, KG1 first." };
  }

  const data = { name, code, stage, order: Math.trunc(orderRaw) };

  try {
    if (id) {
      await prisma.level.update({ where: { id }, data });
      refresh();
      return { ok: `Saved ${name}.` };
    }
    await prisma.level.create({ data: { schoolId: auth.schoolId, ...data } });
    refresh();
    return { ok: `Added ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `Another level already uses the code ${code}.` };
    }
    throw error;
  }
}

export async function deleteLevel(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // ClassGroup, LevelSubject and FeeStructure all cascade from Level, so a
  // delete here would silently take a school's classes and fee tables with it.
  const classes = await prisma.classGroup.count({ where: { levelId: id } });
  const fees = await prisma.feeStructure.count({ where: { levelId: id } });
  if (classes > 0 || fees > 0) {
    return;
  }

  await prisma.level.delete({ where: { id } });
  refresh();
}

export async function saveHouse(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const color = String(formData.get("color") ?? "").trim();

  if (!name) {
    return { error: "Give the house a name." };
  }

  const data = { name, color: color || null };

  try {
    if (id) {
      await prisma.house.update({ where: { id }, data });
    } else {
      await prisma.house.create({ data: { schoolId: auth.schoolId, ...data } });
    }
    refresh();
    return { ok: `Saved ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `There is already a house called ${name}.` };
    }
    throw error;
  }
}

export async function deleteHouse(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Student.houseId is SetNull, so this is safe — but silently un-housing a
  // hundred children is still a surprise, so it only goes through when empty.
  const students = await prisma.student.count({ where: { houseId: id } });
  if (students > 0) {
    return;
  }

  await prisma.house.delete({ where: { id } });
  refresh();
}

export async function saveProgramme(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const code = String(formData.get("code") ?? "").trim().toUpperCase();

  if (!name) {
    return { error: "Give the programme a name, e.g. General Science." };
  }
  if (!code) {
    return { error: "Give the programme a short code." };
  }

  const data = { name, code };

  try {
    if (id) {
      await prisma.programme.update({ where: { id }, data });
    } else {
      await prisma.programme.create({ data: { schoolId: auth.schoolId, ...data } });
    }
    refresh();
    return { ok: `Saved ${name}.` };
  } catch (error) {
    if (duplicate(error)) {
      return { error: `Another programme already uses the code ${code}.` };
    }
    throw error;
  }
}

export async function deleteProgramme(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const students = await prisma.student.count({ where: { programmeId: id } });
  if (students > 0) {
    return;
  }

  await prisma.programme.delete({ where: { id } });
  refresh();
}


/**
 * Fill in the GES ladder and subject offerings for a school that already exists.
 *
 * Provisioning does this automatically, so this is for schools created before
 * that, or one that deleted a level and wants it back. Idempotent: it adds what
 * is missing and leaves everything else alone, including names a school has
 * customised.
 */
export async function applyCurriculum(
  // useActionState requires both parameters; this action reads neither, since
  // the curriculum is fixed and the school comes from the session.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: StructureState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext({ schoolId: auth.schoolId });

  const result = await tenantTransaction(
    auth.schoolId,
    (tx) => applyGesCurriculum(tx, auth.schoolId),
    { timeout: 180_000, maxWait: 20_000 },
  );

  refresh();
  revalidatePath("/subjects");

  if (result.levelsCreated === 0 && result.subjectsCreated === 0 && result.linksCreated === 0) {
    return { ok: "Already set up — nothing was missing." };
  }
  return {
    ok: `Added ${result.levelsCreated} levels, ${result.subjectsCreated} subjects and ${result.linksCreated} subject offerings. Anything already there was left alone.`,
  };
}

/**
 * The components every subject is marked out of. Leadership sets the school
 * default; a teacher adjusts any component's total marks on their own sheet.
 */
export async function saveComponent(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const type = String(formData.get("type") ?? "CLASS_TEST");
  const maxScore = Number(formData.get("maxScore") ?? 0);
  const orderRaw = String(formData.get("order") ?? "").trim();

  if (!title) {
    return { error: "Give the component a name, e.g. “Class Test 1”." };
  }
  if (!Number.isFinite(maxScore) || maxScore <= 0 || maxScore > 1000) {
    return { error: "Total marks must be between 1 and 1000." };
  }

  const isExam = type === "END_OF_TERM_EXAM" || type === "MIDTERM_EXAM";
  const order = orderRaw ? Number(orderRaw) : undefined;

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      if (id) {
        await tx.assessmentTemplate.update({
          where: { id },
          data: {
            title,
            type: type as "CLASS_TEST",
            maxScore: new Prisma.Decimal(maxScore),
            isExam,
            ...(order !== undefined ? { order } : {}),
          },
        });
      } else {
        const last = await tx.assessmentTemplate.findFirst({
          where: { schoolId: auth.schoolId },
          orderBy: { order: "desc" },
        });
        await tx.assessmentTemplate.create({
          data: {
            schoolId: auth.schoolId,
            title,
            type: type as "CLASS_TEST",
            maxScore: new Prisma.Decimal(maxScore),
            isExam,
            order: order ?? (last?.order ?? 0) + 10,
          },
        });
      }

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: id ? "component.update" : "component.create",
        entity: "AssessmentTemplate",
        entityId: id || title,
        after: { title, type, maxScore },
      });
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already a component called “${title}”.` };
    }
    throw error;
  }

  refresh();
  return {
    ok: id
      ? `Saved. Sheets already opened keep their own totals — this changes new ones.`
      : `${title} added. It appears on sheets opened from now on.`,
  };
}

/**
 * Deleting a component removes it from future sheets only. Marks already
 * entered live on Assessment rows, which are untouched — a template is a
 * factory, not the record.
 */
export async function deleteComponent(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const existing = await tx.assessmentTemplate.findUnique({ where: { id } });
    if (!existing) {
      return;
    }
    await tx.assessmentTemplate.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "component.delete",
      entity: "AssessmentTemplate",
      entityId: id,
      before: { title: existing.title, maxScore: existing.maxScore.toString() },
    });
  });

  refresh();
}

/** Offered when the list is empty or partial, like the curriculum button. */
export async function applyDefaultComponents(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: StructureState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    applyDefaultAssessmentTemplate(tx, auth.schoolId),
  );

  refresh();
  if (result.created === 0) {
    return { ok: "Already set up — nothing was missing." };
  }
  return { ok: `Added ${result.created} component${result.created === 1 ? "" : "s"}.` };
}
