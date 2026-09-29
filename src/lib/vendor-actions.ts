"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP, FINANCE } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { parseAmount } from "@/lib/money";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { allocateFifoBills, recalcVendorBill } from "@/lib/bill-engine";
import {
  cashAccountIdForMethod,
  findJournalEntryForSource,
  getCoreAccounts,
  postJournalEntry,
  reverseJournalEntry,
} from "@/lib/ledger-engine";
import { writeAudit } from "@/lib/audit";

export type ActionState = { error?: string; ok?: string };

/** Create or edit a vendor. No code, unlike a category — a vendor is a name, not a classification. */
export async function saveVendor(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("id") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const contactPerson = String(formData.get("contactPerson") ?? "").trim() || null;
  const phone = String(formData.get("phone") ?? "").trim() || null;
  const note = String(formData.get("note") ?? "").trim() || null;

  if (!name) {
    return { error: "Give the vendor a name." };
  }

  try {
    if (id) {
      await prisma.vendor.update({ where: { id }, data: { name, contactPerson, phone, note } });
    } else {
      await prisma.vendor.create({
        data: { schoolId: auth.schoolId, name, contactPerson, phone, note },
      });
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `There is already a vendor called "${name}".` };
    }
    throw error;
  }

  revalidatePath("/creditors");
  return { ok: id ? `${name} updated.` : `${name} added.` };
}

/** A vendor with a bill or payment history is deactivated, never deleted — the same rule as every category in this app. */
export async function deactivateVendor(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("id") ?? "");
  if (!id) {
    return;
  }
  await prisma.vendor.update({ where: { id }, data: { isActive: false } });
  revalidatePath("/creditors");
}

/** A new bill from a vendor. DRAFT until a leader approves it — see approveVendorBill. */
export async function recordVendorBill(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const vendorId = String(formData.get("vendorId") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const amount = parseAmount(formData.get("amount"));
  const categoryId = String(formData.get("categoryId") ?? "") || null;
  const dueDateRaw = String(formData.get("dueDate") ?? "");

  if (!vendorId) {
    return { error: "Choose the vendor this bill is from." };
  }
  if (!description) {
    return { error: "Describe what the bill is for." };
  }
  if (!amount) {
    return { error: "Enter a valid amount greater than zero." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const billNo = await nextNumber(tx, auth.schoolId, "BILL", takenProbes.bill(tx, auth.schoolId));

    const bill = await tx.vendorBill.create({
      data: {
        schoolId: auth.schoolId,
        vendorId,
        categoryId,
        billNo,
        description,
        amount,
        balance: amount,
        dueDate: dueDateRaw ? new Date(dueDateRaw) : null,
        status: "DRAFT",
        recordedByUserId: auth.userId,
      },
    });

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "bill.record",
      entity: "VendorBill",
      entityId: bill.id,
      after: { billNo, amount: amount.toString(), vendorId },
    });
  });

  revalidatePath("/creditors");
  return { ok: "Bill recorded." };
}

/** LEADERSHIP-gated, self-approval refused — mirrors approveExpense exactly. */
export async function approveVendorBill(formData: FormData): Promise<void> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext({ schoolId: auth.schoolId });

  const id = String(formData.get("vendorBillId") ?? "");
  if (!id) {
    redirect("/creditors?error=missing");
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const bill = await tx.vendorBill.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        billNo: true,
        amount: true,
        recordedByUserId: true,
        categoryId: true,
      },
    });
    if (!bill) {
      redirect("/creditors?error=missing");
    }
    if (bill.status !== "DRAFT") {
      redirect("/creditors?error=not-pending");
    }
    if (bill.recordedByUserId === auth.userId) {
      redirect("/creditors?error=own");
    }

    await tx.vendorBill.update({
      where: { id },
      data: { status: "APPROVED", approvedByUserId: auth.userId, approvedAt: new Date() },
    });

    // Approval is when the LIABILITY is incurred, not when it's eventually
    // paid — Dr the expense account (via the bill's category) / Cr Accounts
    // Payable. Skipped entirely for an uncategorised bill or a school that
    // hasn't mapped its accounts yet.
    if (bill.categoryId) {
      const category = await tx.expenseCategory.findUnique({
        where: { id: bill.categoryId },
        select: { expenseAccountId: true },
      });
      const core = await getCoreAccounts(tx, auth.schoolId);
      if (category?.expenseAccountId && core.payableAccountId) {
        await postJournalEntry(tx, auth.schoolId, {
          sourceType: "VENDOR_BILL",
          sourceId: bill.id,
          memo: `Bill ${bill.billNo}`,
          actorUserId: auth.userId,
          lines: [
            { accountId: category.expenseAccountId, debit: bill.amount },
            { accountId: core.payableAccountId, credit: bill.amount },
          ],
        });
      }
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "bill.approve",
      entity: "VendorBill",
      entityId: id,
      after: { billNo: bill.billNo, amount: bill.amount.toString() },
    });
  });

  revalidatePath("/creditors");
  redirect("/creditors?approved=1");
}

/** Refused once a payment has been allocated — cancel the payment first, or the vendor's balance would understate what was actually paid out. */
export async function cancelVendorBill(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const id = String(formData.get("vendorBillId") ?? "");
  if (!id) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const bill = await tx.vendorBill.findUnique({ where: { id } });
    if (!bill || bill.amountPaid.greaterThan(0)) {
      return;
    }
    await tx.vendorBill.update({ where: { id }, data: { status: "CANCELLED" } });

    // An APPROVED bill (with nothing paid yet) already posted its liability
    // at approval time — cancelling it has to reverse that, or the payable
    // account keeps a debt the school no longer owes. A DRAFT bill never
    // posted, so there is nothing to find.
    if (bill.status === "APPROVED" || bill.status === "PARTIALLY_PAID") {
      const originalEntry = await findJournalEntryForSource(tx, auth.schoolId, "VENDOR_BILL", id);
      if (originalEntry) {
        await reverseJournalEntry(tx, auth.schoolId, originalEntry.id, {
          memo: `Reversal of ${bill.billNo}`,
          actorUserId: auth.userId,
        });
      }
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "bill.cancel",
      entity: "VendorBill",
      entityId: id,
      before: { status: bill.status, amount: bill.amount.toString() },
      after: { status: "CANCELLED" },
    });
  });

  revalidatePath("/creditors");
}

/** A payment to a vendor, FIFO-spread across its oldest unpaid bills — mirrors recordPayment. */
export async function recordVendorPayment(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const vendorId = String(formData.get("vendorId") ?? "");
  const amount = parseAmount(formData.get("amount"));
  const method = String(formData.get("method") ?? "CASH");
  const momoNetwork = String(formData.get("momoNetwork") ?? "");
  const reference = String(formData.get("reference") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();

  if (!vendorId) {
    return { error: "Choose the vendor this payment is for." };
  }
  if (!amount) {
    return { error: "Enter a valid amount greater than zero." };
  }
  if (method === "MOBILE_MONEY" && !reference) {
    return { error: "Mobile money payments need the transaction reference." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const bills = await tx.vendorBill.findMany({
      where: { schoolId: auth.schoolId, vendorId, balance: { gt: 0 }, status: { in: ["APPROVED", "PARTIALLY_PAID"] } },
      orderBy: [{ dueDate: "asc" }, { billDate: "asc" }],
      select: { id: true, balance: true },
    });

    const paymentNo = await nextNumber(
      tx,
      auth.schoolId,
      "BILLPMT",
      takenProbes.billPayment(tx, auth.schoolId),
    );

    const payment = await tx.vendorPayment.create({
      data: {
        schoolId: auth.schoolId,
        vendorId,
        paymentNo,
        amount,
        method: method as "CASH",
        momoNetwork: method === "MOBILE_MONEY" && momoNetwork ? (momoNetwork as "MTN") : null,
        reference: reference || null,
        note: note || null,
        recordedByUserId: auth.userId,
      },
    });

    const allocations = allocateFifoBills(bills, amount);
    for (const allocation of allocations) {
      await tx.vendorPaymentAllocation.create({
        data: {
          schoolId: auth.schoolId,
          vendorPaymentId: payment.id,
          vendorBillId: allocation.vendorBillId,
          amount: allocation.amount,
        },
      });
      await recalcVendorBill(tx, allocation.vendorBillId);
    }

    const allocated = allocations.reduce((acc, a) => acc.add(a.amount), new Prisma.Decimal(0));

    // Dr Accounts Payable / Cr the account the method leaves from, for the
    // full amount paid — an overpayment past what's owed is still cash that
    // left, same simplification as recordPayment on the receivable side.
    const core = await getCoreAccounts(tx, auth.schoolId);
    const cashLikeAccountId = cashAccountIdForMethod(core, payment.method);
    if (cashLikeAccountId && core.payableAccountId) {
      await postJournalEntry(tx, auth.schoolId, {
        sourceType: "VENDOR_PAYMENT",
        sourceId: payment.id,
        memo: `Payment ${paymentNo}`,
        actorUserId: auth.userId,
        lines: [
          { accountId: core.payableAccountId, debit: amount },
          { accountId: cashLikeAccountId, credit: amount },
        ],
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "billPayment.record",
      entity: "VendorPayment",
      entityId: payment.id,
      after: {
        paymentNo,
        amount: amount.toString(),
        method,
        allocated: allocated.toString(),
        unallocated: amount.sub(allocated).toString(),
      },
    });
  });

  revalidatePath("/creditors");
  return { ok: "Payment recorded." };
}

/** Undo a vendor payment — drops its allocations and recomputes every bill it touched, mirroring reversePayment. */
export async function reverseVendorPayment(formData: FormData): Promise<void> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });
  const paymentId = String(formData.get("vendorPaymentId") ?? "");
  const reason = String(formData.get("reason") ?? "").trim();
  if (!paymentId) {
    return;
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    const payment = await tx.vendorPayment.findUnique({
      where: { id: paymentId },
      include: { allocations: true },
    });
    if (!payment || payment.reversedAt) {
      return;
    }

    const billIds = payment.allocations.map((a) => a.vendorBillId);

    await tx.vendorPaymentAllocation.deleteMany({ where: { vendorPaymentId: paymentId } });
    await tx.vendorPayment.update({
      where: { id: paymentId },
      data: { reversedAt: new Date(), reversalReason: reason || "No reason given" },
    });
    for (const billId of billIds) {
      await recalcVendorBill(tx, billId);
    }

    const originalEntry = await findJournalEntryForSource(tx, auth.schoolId, "VENDOR_PAYMENT", paymentId);
    if (originalEntry) {
      await reverseJournalEntry(tx, auth.schoolId, originalEntry.id, {
        memo: `Reversal of ${payment.paymentNo}`,
        actorUserId: auth.userId,
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "billPayment.reverse",
      entity: "VendorPayment",
      entityId: paymentId,
      before: { amount: payment.amount.toString() },
      after: { reason, billsAffected: billIds.length },
    });
  });

  revalidatePath("/creditors");
}
