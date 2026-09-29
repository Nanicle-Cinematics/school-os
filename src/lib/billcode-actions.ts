"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { applyDefaultBillCodes } from "@/lib/billcode-defaults";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";

export type ActionState = { error?: string; ok?: string };

/**
 * Create or rename a bill code. Mirrors `saveFeeCategory` exactly: the code is
 * derived from the name on create only, so renaming never orphans an invoice
 * already stamped with it.
 */
export async function saveBillCode(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const rawOrder = String(formData.get("order") ?? "").trim();

  if (!name) {
    return { error: "Give the bill a name." };
  }
  if (name.length > 60) {
    return { error: "That name is too long — keep it under 60 characters." };
  }

  const order = rawOrder ? Number(rawOrder) : undefined;
  if (order !== undefined && (!Number.isFinite(order) || order < 0)) {
    return { error: "Order must be a number." };
  }

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
        const existing = await tx.billCode.findUnique({ where: { id } });
        if (!existing) {
          throw new Error("MISSING");
        }
        await tx.billCode.update({
          where: { id },
          data: { name, ...(order !== undefined ? { order } : {}) },
        });
        await writeAudit(tx, {
          schoolId: auth.schoolId,
          actorUserId: auth.userId,
          action: "billCode.update",
          entity: "BillCode",
          entityId: id,
          before: { name: existing.name, order: existing.order },
          after: { name, order },
        });
        return;
      }

      const last = await tx.billCode.findFirst({
        where: { schoolId: auth.schoolId },
        orderBy: { order: "desc" },
      });
      const created = await tx.billCode.create({
        data: {
          schoolId: auth.schoolId,
          name,
          code,
          order: order ?? (last?.order ?? 0) + 1,
        },
      });
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "billCode.create",
        entity: "BillCode",
        entityId: created.id,
        after: { name, code },
      });
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MISSING") {
      return { error: "That bill code no longer exists." };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already a bill code called "${name}".` };
    }
    throw error;
  }

  revalidatePath("/bill-codes");
  return { ok: id ? `Renamed to ${name}.` : `${name} added.` };
}

/**
 * Refused once the code is on a real invoice — deleting it would not delete
 * the invoice (the FK is SetNull), but it would silently erase which kind of
 * bill that invoice was, which is the whole point of having the code.
 */
export async function deleteBillCode(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const existing = await tx.billCode.findUnique({
      where: { id },
      include: { _count: { select: { invoices: true } } },
    });
    if (!existing || existing._count.invoices > 0) {
      return;
    }
    await tx.billCode.delete({ where: { id } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "billCode.delete",
      entity: "BillCode",
      entityId: id,
      before: { name: existing.name, code: existing.code },
    });
  });

  revalidatePath("/bill-codes");
}

/** Offered when the list is empty or partial, mirroring `applyDefaultFeeItems`. */
export async function applyDefaultBillCodesAction(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: ActionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const result = await tenantTransaction(auth.schoolId, (tx) =>
    applyDefaultBillCodes(tx, auth.schoolId),
  );

  revalidatePath("/bill-codes");

  if (result.created === 0) {
    return { ok: "Nothing to add — the standard bill codes are already here." };
  }
  return { ok: `Added ${result.created} bill code${result.created === 1 ? "" : "s"}.` };
}
