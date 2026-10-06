"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Stage } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { ACADEMIC, OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { applyGesCurriculum } from "@/lib/ges-curriculum";
import { applyDefaultAssessmentTemplate, rolloutComponents } from "@/lib/assessment-templates";
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
  setTenantContext(auth.tenant);

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
  setTenantContext(auth.tenant);
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

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.level.delete({ where: { id} });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "level.delete",
      entity: "Level",
      entityId: id,
    });
  });
  refresh();
}

export async function saveHouse(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

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
  setTenantContext(auth.tenant);
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

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.house.delete({ where: { id} });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "house.delete",
      entity: "House",
      entityId: id,
    });
  });
  refresh();
}

export async function saveProgramme(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

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
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  const students = await prisma.student.count({ where: { programmeId: id } });
  if (students > 0) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.programme.delete({ where: { id} });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "programme.delete",
      entity: "Programme",
      entityId: id,
    });
  });
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
  setTenantContext(auth.tenant);

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
 * The components every subject is marked out of.
 *
 * ACADEMIC (leadership + IT_ADMIN), matching who can even open this screen —
 * `/settings/components` itself is gated the same way. It used to require
 * strict LEADERSHIP while the page rendered for IT_ADMIN too, so an IT admin
 * saw a fully-enabled form whose every submit silently redirected away
 * (`requireRole` on a mismatch, with no error to show) — Add/Save/Delete all
 * looked broken from where they were sitting.
 */
export async function saveComponent(
  _prev: StructureState,
  formData: FormData,
): Promise<StructureState> {
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);

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
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);
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
  const auth = await requireRole(ACADEMIC);
  setTenantContext(auth.tenant);

  const { template, rollout } = await tenantTransaction(auth.schoolId, async (tx) => {
    const template = await applyDefaultAssessmentTemplate(tx, auth.schoolId);

    // The template alone is not the point — a class already marking this
    // term needs the new standard ON ITS SHEET, not just recorded somewhere
    // in Settings. Runs every time, even when the template itself did not
    // change, so clicking this again after a class opens a NEW sheet catches
    // it up too.
    const currentTerm = await tx.term.findFirst({ where: { isCurrent: true }, select: { id: true } });
    const rollout = currentTerm
      ? await rolloutComponents(tx, auth.schoolId, currentTerm.id, auth.staffId)
      : null;

    return { template, rollout };
  });

  refresh();
  // Only this action creates Assessment rows, so only this action needs to
  // tell those two pages their cached data is stale.
  revalidatePath("/assessments");
  revalidatePath("/assessments/sheet");

  const templateParts = [
    template.created > 0 ? `${template.created} added` : null,
    template.updated > 0 ? `${template.updated} updated` : null,
    template.removed > 0 ? `${template.removed} removed` : null,
  ].filter(Boolean);
  const templateMsg =
    templateParts.length > 0 ? `${templateParts.join(", ")}.` : "Already matches the standard.";

  if (!rollout) {
    return { ok: `${templateMsg} No current term is set, so no sheet was updated.` };
  }
  const rolloutMsg =
    rollout.created > 0
      ? ` Applied to ${rollout.pairs} class${rollout.pairs === 1 ? "" : "es"} already marking this term — ${rollout.created} new component${rollout.created === 1 ? "" : "s"} added.`
      : rollout.pairs > 0
        ? ` ${rollout.pairs} class${rollout.pairs === 1 ? "" : "es"} already marking this term ${rollout.pairs === 1 ? "was" : "were"} already up to date.`
        : "";
  return { ok: `${templateMsg}${rolloutMsg}` };
}
