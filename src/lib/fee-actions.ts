"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction, prisma } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { writeAudit } from "@/lib/audit";

export type ActionState = { error?: string; ok?: string };

/**
 * Create or replace a level's fee structure for the year. Items are rewritten
 * wholesale rather than diffed — a fee list is small, and replacing it is far
 * easier to reason about than merging.
 */
export async function saveFeeStructure(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);

  const levelId = String(formData.get("levelId") ?? "");
  const academicYearId = String(formData.get("academicYearId") ?? "");
  const termId = String(formData.get("termId") ?? "");
  const residency = String(formData.get("residency") ?? "ANY");
  const studentType = String(formData.get("studentType") ?? "ANY");
  const structureId = String(formData.get("structureId") ?? "");

  if (!levelId || !academicYearId) {
    return { error: "Choose a level." };
  }

  // Category amounts arrive as amount:<categoryId> fields.
  const lines: { feeCategoryId: string; amount: ReturnType<typeof parseAmount> }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("amount:")) {
      continue;
    }
    const feeCategoryId = key.slice("amount:".length);
    const amount = parseAmount(value);
    if (amount) {
      lines.push({ feeCategoryId, amount });
    }
  }

  if (lines.length === 0) {
    return { error: "Enter an amount for at least one fee item." };
  }

  const level = await prisma.level.findUnique({ where: { id: levelId } });
  if (!level) {
    return { error: "That level no longer exists." };
  }

  await tenantTransaction(async (tx) => {
    const data = {
      schoolId: auth.schoolId,
      academicYearId,
      termId: termId || null,
      levelId,
      name: `${level.name} — ${residency === "ANY" ? "all students" : residency.toLowerCase()}`,
      residency: residency as "ANY" | "DAY" | "BOARDING",
      studentType: studentType as "ANY" | "NEW" | "CONTINUING",
      isActive: true,
    };

    const structure = structureId
      ? await tx.feeStructure.update({ where: { id: structureId }, data })
      : await tx.feeStructure.create({ data });

    await tx.feeStructureItem.deleteMany({ where: { feeStructureId: structure.id } });
    await tx.feeStructureItem.createMany({
      data: lines.map((line) => ({
        schoolId: auth.schoolId,
        feeStructureId: structure.id,
        feeCategoryId: line.feeCategoryId,
        amount: line.amount!,
      })),
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: structureId ? "feeStructure.update" : "feeStructure.create",
      entity: "FeeStructure",
      entityId: structure.id,
      after: { levelId, residency, studentType, lines: lines.length },
    });
  });

  revalidatePath("/fees");
  return { ok: `Fee structure saved for ${level.name}.` };
}

export async function deleteFeeStructure(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  const id = String(formData.get("structureId") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(async (tx) => {
    const existing = await tx.feeStructure.findUnique({ where: { id }, include: { items: true } });
    if (!existing) {
      return;
    }
    await tx.feeStructure.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "feeStructure.delete",
      entity: "FeeStructure",
      entityId: id,
      before: { name: existing.name, items: existing.items.length },
    });
  });

  revalidatePath("/fees");
}
