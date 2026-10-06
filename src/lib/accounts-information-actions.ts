"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";

export type ActionState = { error?: string; ok?: string };

/**
 * What an accountant needs printed on a bill and nothing else: the school's
 * tax identifier, and how a parent actually pays. `paymentInstructions` stays
 * deliberately free text (see SchoolSettings) — schools use momo, a bank, the
 * bursar's window or all three, and the arrangement changes without warning.
 *
 * FINANCE-gated rather than OFFICE, unlike the rest of /settings: this is
 * money content printed on a bill, and IT_ADMIN is kept out of the school's
 * money everywhere else in the app.
 */
export async function saveAccountsInformation(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext(auth.tenant);

  const tin = String(formData.get("tin") ?? "").trim();
  const paymentInstructions = String(formData.get("paymentInstructions") ?? "").trim();
  const invoiceNote = String(formData.get("invoiceNote") ?? "").trim();

  if (paymentInstructions.length > 600) {
    return { error: "Keep the payment details under 600 characters — they share a page with the bill." };
  }
  if (invoiceNote.length > 200) {
    return { error: "Keep the note under 200 characters — it prints as one line." };
  }

  await prisma.school.update({
    where: { id: auth.schoolId },
    data: { tin: tin || null },
  });

  await prisma.schoolSettings.upsert({
    where: { schoolId: auth.schoolId },
    create: {
      schoolId: auth.schoolId,
      paymentInstructions: paymentInstructions || null,
      invoiceNote: invoiceNote || null,
    },
    update: {
      paymentInstructions: paymentInstructions || null,
      invoiceNote: invoiceNote || null,
    },
  });

  revalidatePath("/accounts-information");
  revalidatePath("/invoices");
  revalidatePath("/expenses");
  return { ok: "Billing details saved." };
}
