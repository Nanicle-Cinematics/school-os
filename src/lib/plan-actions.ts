"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { tenantTransaction } from "@/lib/prisma";
import { splitEvenly } from "@/lib/plan-engine";
import { writeAudit } from "@/lib/audit";

export type PlanState = { error?: string; ok?: string };

const MAX_INSTALMENTS = 12;

/**
 * Agree an arrangement to pay one bill in tranches.
 *
 * ⚠️ The schedule is built from the invoice's CURRENT BALANCE, not its total.
 * A family that has already paid half and then asks to spread the rest should
 * be given a plan for the rest; scheduling the whole bill again would ask for
 * money the school has already received, and the first tranche would be in
 * arrears the moment it was written.
 */
export async function createPlan(_prev: PlanState, formData: FormData): Promise<PlanState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const invoiceId = String(formData.get("invoiceId") ?? "");
  const count = Number(formData.get("count"));
  const firstDueRaw = String(formData.get("firstDue") ?? "");
  const everyDays = Number(formData.get("everyDays") || 30);
  const note = String(formData.get("note") ?? "").trim();

  if (!invoiceId) {
    return { error: "Which bill is this plan for?" };
  }
  if (!Number.isInteger(count) || count < 2 || count > MAX_INSTALMENTS) {
    return { error: `A plan needs between 2 and ${MAX_INSTALMENTS} instalments.` };
  }
  if (!firstDueRaw || Number.isNaN(Date.parse(firstDueRaw))) {
    return { error: "When is the first instalment due?" };
  }
  if (!Number.isFinite(everyDays) || everyDays < 1 || everyDays > 120) {
    return { error: "Space the instalments between 1 and 120 days apart." };
  }

  try {
    await tenantTransaction(auth.schoolId, async (tx) => {
      const invoice = await tx.invoice.findUnique({
        where: { id: invoiceId },
        select: { id: true, balance: true, status: true, invoiceNo: true, paymentPlan: { select: { id: true } } },
      });
      if (!invoice) {
        throw new Error("NOT_FOUND");
      }
      if (invoice.paymentPlan) {
        throw new Error("ALREADY");
      }
      if (invoice.status === "CANCELLED") {
        throw new Error("CANCELLED");
      }
      if (Number(invoice.balance) <= 0) {
        throw new Error("SETTLED");
      }

      const amounts = splitEvenly(invoice.balance, count);
      const first = new Date(firstDueRaw);

      const plan = await tx.paymentPlan.create({
        data: {
          schoolId: auth.schoolId,
          invoiceId,
          note: note || null,
          agreedByUserId: auth.userId,
        },
        select: { id: true },
      });

      await tx.paymentPlanInstalment.createMany({
        data: amounts.map((amount, index) => ({
          schoolId: auth.schoolId,
          planId: plan.id,
          sequence: index + 1,
          dueDate: new Date(first.getTime() + index * everyDays * 86_400_000),
          amount,
        })),
      });

      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "plan.create",
        entity: "PaymentPlan",
        entityId: plan.id,
        after: {
          invoiceNo: invoice.invoiceNo,
          count,
          amount: invoice.balance.toString(),
        },
      });
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    if (reason === "ALREADY") return { error: "That bill already has a plan. Cancel it first." };
    if (reason === "SETTLED") return { error: "That bill is settled — there is nothing to spread." };
    if (reason === "CANCELLED") return { error: "That bill is cancelled." };
    if (reason === "NOT_FOUND") return { error: "That bill no longer exists." };
    throw error;
  }

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  return { ok: `Plan agreed — ${count} instalments.` };
}

/**
 * End an arrangement.
 *
 * Marked cancelled rather than deleted: a school that agreed to spread a bill
 * and later withdrew it needs to be able to say when and who, and a parent will
 * ask. The instalments stay with it for the same reason.
 */
export async function cancelPlan(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const planId = String(formData.get("planId") ?? "");
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!planId) {
    redirect("/invoices");
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    // The plan must belong to the invoice the page said, and a plan already
    // ended keeps the date it was ended.
    const plan = await tx.paymentPlan.findFirst({
      where: { id: planId, invoiceId, cancelledAt: null },
      select: { id: true },
    });
    if (!plan) {
      return;
    }
    await tx.paymentPlan.update({
      where: { id: planId },
      data: { cancelledAt: new Date() },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "plan.cancel",
      entity: "PaymentPlan",
      entityId: planId,
      after: {},
    });
  });

  revalidatePath(`/invoices/${invoiceId}`);
  revalidatePath("/invoices");
  redirect(`/invoices/${invoiceId}`);
}
