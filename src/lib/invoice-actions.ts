"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import {
  generateInvoicesForTerm,
  groupSkipped,
  recalcInvoice,
  type BlockedGroup,
} from "@/lib/invoice-engine";
import { writeAudit } from "@/lib/audit";

export type GenerateState = {
  error?: string;
  ok?: string;
  /** Grouped by cause, so the banner can name the screen that fixes each. */
  blocked?: BlockedGroup[];
};

export async function generateInvoices(
  _prev: GenerateState,
  formData: FormData,
): Promise<GenerateState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const termId = String(formData.get("termId") ?? "");

  if (!termId) {
    return { error: "Choose a term first." };
  }

  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });
  const dueDays = settings?.invoiceDueDays ?? 14;

  // Generous timeout: this walks every active student and writes an invoice
  // plus its lines for each, and the database is a continent away.
  const result = await tenantTransaction(auth.schoolId, async (tx) => {
      const generated = await generateInvoicesForTerm(tx, auth.schoolId, termId, dueDays);
      await writeAudit(tx, {
        schoolId: auth.schoolId,
        actorUserId: auth.userId,
        action: "invoice.generateBatch",
        entity: "Term",
        entityId: termId,
        after: { created: generated.created, skipped: generated.skipped },
      });
      return generated;
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  revalidatePath("/invoices");
  revalidatePath("/dashboard");

  if (result.created === 0 && result.noStructure.length === 0) {
    return { ok: `Nothing to do — all ${result.skipped} students already have an invoice.` };
  }

  return {
    ok:
      `Created ${result.created} invoice${result.created === 1 ? "" : "s"}` +
      (result.skipped > 0 ? `, skipped ${result.skipped} already invoiced` : "") +
      ".",
    blocked: result.noStructure.length > 0 ? groupSkipped(result.noStructure) : undefined,
  };
}

export async function cancelInvoice(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { allocations: true },
    });
    if (!invoice) {
      return;
    }
    // Refuse to cancel an invoice that has money against it — that needs a
    // payment reversal first, which is a separate, audited decision.
    if (invoice.allocations.length > 0) {
      return;
    }

    await tx.invoice.update({ where: { id: invoiceId }, data: { status: "CANCELLED" } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "invoice.cancel",
      entity: "Invoice",
      entityId: invoiceId,
      before: { status: invoice.status, total: invoice.total.toString() },
      after: { status: "CANCELLED" },
    });
  });

  revalidatePath("/invoices");
  revalidatePath(`/invoices/${invoiceId}`);
}

export async function recomputeInvoice(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) {
    return;
  }
  await tenantTransaction(auth.schoolId, (tx) => recalcInvoice(tx, invoiceId));
  revalidatePath(`/invoices/${invoiceId}`);
}
