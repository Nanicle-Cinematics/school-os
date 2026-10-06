"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { applyDefaultFinanceCategories } from "@/lib/finance-defaults";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction, prisma } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { writeAudit } from "@/lib/audit";

const MAX_FEE = new Prisma.Decimal("9999999.99");

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
  setTenantContext(auth.tenant);

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

  // Everything below came from the request, so it is checked against what exists
  // rather than cast: a bad value used to surface as a database error.
  if (!["ANY", "DAY", "BOARDING"].includes(residency)) {
    return { error: "Choose who the fees apply to: everyone, day pupils or boarders." };
  }
  if (!["ANY", "NEW", "CONTINUING"].includes(studentType)) {
    return { error: "Choose whether the fees are for new pupils, continuing ones or both." };
  }
  if (lines.some((line) => line.amount!.greaterThan(MAX_FEE))) {
    return { error: "One of those amounts is too large — check for an extra digit." };
  }

  const year = await prisma.academicYear.findUnique({ where: { id: academicYearId }, select: { id: true } });
  if (!year) {
    return { error: "That academic year no longer exists." };
  }
  if (termId) {
    const term = await prisma.term.findFirst({ where: { id: termId, academicYearId }, select: { id: true } });
    if (!term) {
      return { error: "That term does not belong to the chosen year." };
    }
  }
  const known = await prisma.feeCategory.count({
    where: { id: { in: lines.map((line) => line.feeCategoryId) } },
  });
  if (known !== lines.length) {
    return { error: "A fee item on that form no longer exists. Reload the page and try again." };
  }

  // Two structures with the same level, year, term, residency and type tie, and the
  // bill then uses whichever the database returns first. One per combination.
  const twin = await prisma.feeStructure.findFirst({
    where: {
      levelId,
      academicYearId,
      termId: termId || null,
      residency: residency as "ANY" | "DAY" | "BOARDING",
      studentType: studentType as "ANY" | "NEW" | "CONTINUING",
      isActive: true,
      ...(structureId ? { id: { not: structureId } } : {}),
    },
    select: { id: true },
  });
  if (twin) {
    return {
      error: `${level.name} already has a fee structure for exactly those conditions. Edit that one instead of adding a second.`,
    };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
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

/**
 * Fee items are the lines a bill is made of, so they are the first thing a
 * school needs and the one thing the structure form cannot do without — with
 * none defined there is no field to type an amount into.
 */
export async function saveFeeCategory(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const rawOrder = String(formData.get("order") ?? "").trim();

  if (!name) {
    return { error: "Give the fee item a name." };
  }
  if (name.length > 60) {
    return { error: "That name is too long for a bill line — keep it under 60 characters." };
  }

  const order = rawOrder ? Number(rawOrder) : undefined;
  if (order !== undefined && (!Number.isFinite(order) || order < 0)) {
    return { error: "Order must be a number." };
  }

  // The code is the stable handle and must stay unique per school. It is
  // derived rather than asked for, because a bursar should not have to invent
  // one — but it is only derived on create, so renaming "PTA Levy" to "PTA and
  // Development Levy" does not orphan the structures priced against it.
  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  if (!code) {
    return { error: "Use at least one letter or number in the name." };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      if (id) {
        const existing = await tx.feeCategory.findUnique({ where: { id } });
        if (!existing) {
          throw new Error("MISSING");
        }
        await tx.feeCategory.update({
          where: { id },
          data: { name, ...(order !== undefined ? { order } : {}) },
        });
        await writeAudit(tx, {
          schoolId: auth.schoolId,
          actorUserId: auth.userId,
          action: "feeCategory.update",
          entity: "FeeCategory",
          entityId: id,
          before: { name: existing.name, order: existing.order },
          after: { name, order },
        });
        return;
      }

      const last = await tx.feeCategory.findFirst({
        where: { schoolId: auth.schoolId },
        orderBy: { order: "desc" },
      });
      const created = await tx.feeCategory.create({
        data: {
          schoolId: auth.schoolId,
          name,
          code,
          order: order ?? (last?.order ?? 0) + 1,
          isMandatory: true,
        },
      });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "feeCategory.create",
        entity: "FeeCategory",
        entityId: created.id,
        after: { name, code },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MISSING") {
      return { error: "That fee item no longer exists." };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already a fee item called "${name}".` };
    }
    throw error;
  }

  revalidatePath("/fees");
  return { ok: id ? `Renamed to ${name}.` : `${name} added. It can now be priced per level.` };
}

/**
 * Refused once the item is priced or billed. Deleting it would cascade the
 * structure lines away and silently change what every level costs; a school
 * that has stopped charging it prices it at zero, or removes the line from the
 * structures that carry it.
 */
export async function deleteFeeCategory(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const existing = await tx.feeCategory.findUnique({
      where: { id },
      include: { _count: { select: { structureItems: true, invoiceItems: true } } },
    });
    if (!existing) {
      return;
    }
    if (existing._count.structureItems > 0 || existing._count.invoiceItems > 0) {
      return;
    }
    await tx.feeCategory.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "feeCategory.delete",
      entity: "FeeCategory",
      entityId: id,
      before: { name: existing.name, code: existing.code },
    });
  });

  revalidatePath("/fees");
}

/** Offered when the list is empty or partial, mirroring the curriculum button. */
export async function applyDefaultFeeItems(
  // useActionState requires both; the list is fixed and the school comes from
  // the session, so neither is read.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: ActionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    applyDefaultFinanceCategories(tx, auth.schoolId),
  );

  revalidatePath("/fees");
  revalidatePath("/expenses");

  if (result.feeCategoriesCreated === 0 && result.expenseCategoriesCreated === 0) {
    return { ok: "Nothing to add — the standard items are already here." };
  }
  return {
    ok: `Added ${result.feeCategoriesCreated} fee item${
      result.feeCategoriesCreated === 1 ? "" : "s"
    }. Rename or delete any the school does not charge, then price them per level.`,
  };
}

export async function deleteFeeStructure(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);
  const id = String(formData.get("structureId") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
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
