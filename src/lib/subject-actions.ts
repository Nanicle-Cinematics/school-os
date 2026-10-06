"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { OFFICE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type SubjectState = { error?: string; ok?: string };

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export async function saveSubject(
  _prev: SubjectState,
  formData: FormData,
): Promise<SubjectState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  // Codes end up on the broadsheet and the report card, where column width is
  // scarce — uppercase and squashed so "int sci" and "INT SCI" cannot both exist.
  const code = String(formData.get("code") ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");
  const isCore = formData.get("isCore") === "on";
  const orderRaw = Number(formData.get("order"));
  const order = Number.isFinite(orderRaw) ? Math.trunc(orderRaw) : 0;

  if (!name) {
    return { error: "Give the subject a name." };
  }
  if (!code) {
    return { error: "Give the subject a short code — it heads the broadsheet column." };
  }

  try {
    if (id) {
      await prisma.subject.update({
        where: { id },
        data: { name, code, isCore, order },
      });
      revalidatePath(`/subjects/${id}`);
      revalidatePath("/subjects");
      return { ok: `Saved ${name}.` };
    }

    const subject = await prisma.subject.create({
      data: { schoolId: auth.schoolId, name, code, isCore, order },
    });
    revalidatePath("/subjects");
    return { ok: `Added ${subject.name}. Set the levels that offer it.` };
  } catch (error) {
    if (isUniqueViolation(error)) {
      return { error: `Another subject already uses the code ${code}.` };
    }
    throw error;
  }
}

/**
 * Replace the set of levels offering a subject.
 *
 * Rows are upserted rather than wiped and re-created so the per-level flags of
 * levels that stay ticked survive, and so a level that is unticked by accident
 * and re-ticked does not silently reset "counts for aggregate".
 */
export async function saveSubjectLevels(
  _prev: SubjectState,
  formData: FormData,
): Promise<SubjectState> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);

  const subjectId = String(formData.get("subjectId") ?? "");
  if (!subjectId) {
    return { error: "Missing subject." };
  }

  const offered = formData.getAll("offered").map(String);
  const levels = await prisma.level.findMany({ select: { id: true } });
  const keep = new Set(levels.filter((level) => offered.includes(level.id)).map((l) => l.id));

  await prisma.levelSubject.deleteMany({
    where: { subjectId, levelId: { notIn: [...keep] } },
  });

  for (const levelId of keep) {
    await prisma.levelSubject.upsert({
      where: { levelId_subjectId: { levelId, subjectId } },
      create: {
        schoolId: auth.schoolId,
        levelId,
        subjectId,
        isElective: formData.get(`elective:${levelId}`) === "on",
        countsForAggregate: formData.get(`aggregate:${levelId}`) === "on",
      },
      update: {
        isElective: formData.get(`elective:${levelId}`) === "on",
        countsForAggregate: formData.get(`aggregate:${levelId}`) === "on",
      },
    });
  }

  revalidatePath(`/subjects/${subjectId}`);
  revalidatePath("/subjects");
  return { ok: keep.size === 0 ? "Subject is offered at no level." : `Offered at ${keep.size} level${keep.size === 1 ? "" : "s"}.` };
}

export async function deleteSubject(formData: FormData): Promise<void> {
  const auth = await requireRole(OFFICE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  // Grades reference the subject by id; removing it would orphan a published
  // report card. Anything already assessed stays forever.
  const [assessments, results] = await Promise.all([
    prisma.assessment.count({ where: { subjectId: id } }),
    prisma.subjectResult.count({ where: { subjectId: id } }),
  ]);

  if (assessments > 0 || results > 0) {
    redirect(`/subjects/${id}?error=in-use`);
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.subject.delete({ where: { id} });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "subject.delete",
      entity: "Subject",
      entityId: id,
    });
  });
  revalidatePath("/subjects");
  redirect("/subjects");
}
