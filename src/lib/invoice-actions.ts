"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import {
  generateInvoicesForTerm,
  groupSkipped,
  recalcInvoice,
  syncCarriedForward,
  type BlockedGroup,
} from "@/lib/invoice-engine";
import { writeAudit } from "@/lib/audit";
import { lockOn } from "@/lib/locks";
import { findJournalEntryForSource, reverseJournalEntry } from "@/lib/ledger-engine";

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
  setTenantContext(auth.tenant);
  const termId = String(formData.get("termId") ?? "");

  if (!termId) {
    return { error: "Choose a term first." };
  }

  const settings = await prisma.schoolSettings.findUnique({ where: { schoolId: auth.schoolId } });
  const dueDays = settings?.invoiceDueDays ?? 14;

  // Generous timeout: this walks every active student and writes an invoice
  // plus its lines for each, and the database is a continent away.
  let result;
  try {
  result = await tenantTransaction(auth.schoolId, async (tx) => {
      const generated = await generateInvoicesForTerm(tx, auth.schoolId, termId, dueDays, auth.userId);
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
  } catch (error) {
    // Two presses at once: the other run created them first. Nothing was lost.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: "Invoices for that term are already being generated. Reload the page to see them." };
    }
    throw error;
  }

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
  setTenantContext(auth.tenant);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await lockOn(tx, `invoice:${invoiceId}`);
    const invoice = await tx.invoice.findUnique({
      where: { id: invoiceId },
      include: { allocations: true },
    });
    if (!invoice || invoice.status === "CANCELLED") {
      return;
    }
    // Refuse to cancel an invoice that has money against it — that needs a
    // payment reversal first, which is a separate, audited decision.
    if (invoice.allocations.length > 0) {
      return;
    }

    await tx.invoice.update({ where: { id: invoiceId }, data: { status: "CANCELLED" } });

    // Generating the invoice posted Dr receivables / Cr income. Cancelling it
    // has to take that back, or the ledger keeps a debt and a revenue the
    // invoice list no longer shows. Best-effort like every posting: a school
    // that had not mapped its accounts has no entry to reverse.
    const posted = await findJournalEntryForSource(tx, auth.schoolId, "INVOICE", invoiceId);
    if (posted) {
      await reverseJournalEntry(tx, auth.schoolId, posted.id, {
        memo: `Reversal of ${invoice.invoiceNo}`,
        actorUserId: auth.userId,
      });
    }
    // A cancelled invoice stops being carried into the next one.
    await syncCarriedForward(tx, invoice.studentId);

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
  setTenantContext(auth.tenant);
  const invoiceId = String(formData.get("invoiceId") ?? "");
  if (!invoiceId) {
    return;
  }
  await tenantTransaction(auth.schoolId, async (tx) => {
    const invoice = await recalcInvoice(tx, invoiceId);
    await syncCarriedForward(tx, invoice.studentId);
  });
  revalidatePath(`/invoices/${invoiceId}`);
}
