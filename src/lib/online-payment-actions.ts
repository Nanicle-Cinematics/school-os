"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { LEADERSHIP } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { writeAudit } from "@/lib/audit";
import { requireMyChild } from "@/lib/portal-auth";
import { getChildFinance } from "@/lib/portal-data";
import { parseAmount } from "@/lib/money";
import { encryptGatewaySecret, decryptGatewaySecret } from "@/lib/gateway-crypto";
import { initializeTransaction, newReference, parseSecretKey, testKey, toPesewas } from "@/lib/paystack";
import { settleOnlinePayment, type SettleState } from "@/lib/online-payment-engine";

export type GatewayState = { error?: string; ok?: string };
/** `amount` is what was typed, handed back so a refusal does not reset the box to the full balance. */
export type CheckoutState = { error?: string; amount?: string };

const MAX_ONLINE = new Prisma.Decimal("1000000");
/** Open checkouts one parent may have started in the last hour before we ask them to finish or wait. */
const MAX_OPEN_PER_HOUR = 8;

function appBaseUrl() {
  return (process.env.APP_URL ?? "https://www.schoolosafrica.com").replace(/\/$/, "");
}

/* ─────────────────────────── the school's key (leadership) ─────────────────────────── */

/**
 * Save the school's Paystack secret key.
 *
 * LEADERSHIP, not OFFICE: this is the key to where the school's money lands, so the IT admin (who is
 * kept out of the money on purpose) cannot change it. The key is checked against Paystack before it
 * is stored, so a typo is caught here and not by the first parent who tries to pay. It is encrypted
 * at rest and is never sent back to a browser or written to the audit trail.
 */
export async function saveGatewayKey(_prev: GatewayState, formData: FormData): Promise<GatewayState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const parsed = parseSecretKey(String(formData.get("secretKey") ?? ""));
  if (!parsed.ok) {
    return { error: parsed.error };
  }

  const tested = await testKey(parsed.key);
  if (!tested.ok) {
    return { error: tested.error };
  }

  let secretKeyEnc: string;
  try {
    secretKeyEnc = encryptGatewaySecret(parsed.key);
  } catch {
    return { error: "This deployment cannot store the key safely yet (its encryption key is not set). Ask the maintainer." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    // A new key starts switched OFF: the head turns it on deliberately, after the webhook is set up.
    await tx.paymentGateway.upsert({
      where: { schoolId: auth.schoolId },
      create: { schoolId: auth.schoolId, secretKeyEnc, mode: parsed.mode, enabled: false },
      update: { secretKeyEnc, mode: parsed.mode, enabled: false },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "gateway.save",
      entity: "PaymentGateway",
      entityId: auth.schoolId,
      after: { provider: "PAYSTACK", mode: parsed.mode },
    });
  });

  revalidatePath("/settings/online-payments");
  return { ok: `Paystack ${parsed.mode} key saved. Online payments are still off until you switch them on.` };
}

export async function setGatewayEnabled(_prev: GatewayState, formData: FormData): Promise<GatewayState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  const enable = formData.get("enable") === "1";
  const existing = await prisma.paymentGateway.findUnique({
    where: { schoolId: auth.schoolId },
    select: { secretKeyEnc: true },
  });
  if (enable && !existing?.secretKeyEnc) {
    return { error: "Save a Paystack secret key first." };
  }
  if (!existing) {
    return { ok: "Online payments are off." };
  }

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.paymentGateway.update({ where: { schoolId: auth.schoolId }, data: { enabled: enable } });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: enable ? "gateway.enable" : "gateway.disable",
      entity: "PaymentGateway",
      entityId: auth.schoolId,
    });
  });

  revalidatePath("/settings/online-payments");
  revalidatePath("/portal", "layout");
  return { ok: enable ? "Parents can now pay online." : "Online payments are off. Payments already started will still be recorded." };
}

export async function removeGatewayKey(): Promise<GatewayState> {
  const auth = await requireRole(LEADERSHIP);
  setTenantContext(auth.tenant);

  await tenantTransaction(auth.schoolId, async (tx) => {
    await tx.paymentGateway.updateMany({
      where: { schoolId: auth.schoolId },
      data: { secretKeyEnc: null, mode: null, enabled: false },
    });
    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "gateway.remove",
      entity: "PaymentGateway",
      entityId: auth.schoolId,
    });
  });

  revalidatePath("/settings/online-payments");
  return { ok: "The Paystack key was removed." };
}

/* ─────────────────────────── a parent pays ─────────────────────────── */

/**
 * Start a checkout for one of the signed-in parent's own children.
 *
 * Everything that matters is decided here, on the server, and none of it comes from the browser
 * except the child's id and the amount asked for: the child must be this guardian's
 * (`requireMyChild`, a 404 otherwise); the amount must be above zero and no more than what is
 * actually owing (read now, not trusted from the page); the school must have switched online
 * payments on; and the amount is written to OUR row before the parent leaves, so what Paystack
 * later reports is compared with what we recorded, not with anything sent back.
 */
export async function startCheckout(
  studentId: string,
  _prev: CheckoutState,
  formData: FormData,
): Promise<CheckoutState> {
  const ctx = await requireMyChild(studentId);
  setTenantContext(ctx.tenant);

  const fail = (error: string): CheckoutState => ({ error, amount: String(formData.get("amount") ?? "") });

  if (ctx.tenant.readOnly) {
    return fail("The school is not taking online payments right now. Please contact the school office.");
  }

  const amount = parseAmount(formData.get("amount"));
  if (!amount) {
    return fail("Enter an amount greater than zero.");
  }
  if (toPesewas(amount) === null || amount.greaterThan(MAX_ONLINE)) {
    return fail("That amount is not valid. Use cedis and pesewas, for example 250.00.");
  }

  const gateway = await prisma.paymentGateway.findUnique({
    where: { schoolId: ctx.schoolId },
    select: { enabled: true, secretKeyEnc: true },
  });
  if (!gateway?.enabled || !gateway.secretKeyEnc) {
    return fail("This school has not switched on online payments. Please pay at the school office.");
  }

  const { outstanding } = await getChildFinance(studentId);
  const owing = new Prisma.Decimal(outstanding.toString());
  if (owing.lte(0)) {
    return fail("There is nothing owing for this child.");
  }
  if (amount.greaterThan(owing)) {
    return fail(`That is more than the ${owing.toFixed(2)} owing. Enter that amount or less.`);
  }

  const recent = await prisma.onlinePayment.count({
    where: {
      guardianId: ctx.guardianId,
      status: "PENDING",
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recent >= MAX_OPEN_PER_HOUR) {
    return fail("You have several payments waiting to finish. Please complete one or try again in an hour.");
  }

  let secretKey: string;
  try {
    secretKey = decryptGatewaySecret(gateway.secretKeyEnc);
  } catch {
    return fail("Online payment is not working for this school right now. Please pay at the school office.");
  }

  const guardian = await prisma.guardian.findUnique({
    where: { id: ctx.guardianId },
    select: { email: true },
  });

  const reference = newReference(randomBytes(12));
  await prisma.onlinePayment.create({
    data: {
      schoolId: ctx.schoolId,
      studentId,
      guardianId: ctx.guardianId,
      reference,
      amount,
    },
  });

  // Paystack insists on an email. Parents here often have none, so a stable stand-in is used; the
  // address only appears on Paystack's own receipt and is never one the school or the app mails.
  const email = guardian?.email?.trim() || `parent-${ctx.guardianId}@parents.schoolosafrica.com`;

  const started = await initializeTransaction(secretKey, {
    email,
    amountPesewas: toPesewas(amount)!,
    reference,
    callbackUrl: `${appBaseUrl()}/portal/${studentId}/fees?ref=${reference}`,
    metadata: { school: ctx.schoolId, student: studentId, reference },
  });

  if (!started.ok) {
    await prisma.onlinePayment.updateMany({
      where: { schoolId: ctx.schoolId, reference, status: "PENDING" },
      data: { status: "FAILED", problem: started.error.slice(0, 200) },
    });
    return fail("Paystack could not start the payment. Please try again, or pay at the school office.");
  }

  redirect(started.url);
}

/* ─────────────────────────── the parent comes back ─────────────────────────── */

export type ConfirmState = { state: SettleState | "none"; receiptNo?: string };

/**
 * Ask whether a checkout the parent just made has been paid, and book it if so.
 *
 * Paystack's webhook is the main path, but a school that never pasted its webhook address into the
 * Paystack dashboard would otherwise take money and record nothing. This runs the SAME settlement
 * (which verifies with Paystack and trusts nothing from the page), so it is safe to call from a
 * parent's browser and safe to call twice. The reference must belong to a child of this guardian.
 */
export async function confirmOnlinePayment(studentId: string, reference: string): Promise<ConfirmState> {
  const ctx = await requireMyChild(studentId);
  setTenantContext(ctx.tenant);

  if (!/^SOS-[0-9A-F]{24}$/.test(reference)) {
    return { state: "none" };
  }
  const mine = await prisma.onlinePayment.findFirst({
    where: { schoolId: ctx.schoolId, reference, studentId },
    select: { id: true, status: true, payment: { select: { receiptNo: true } } },
  });
  if (!mine) {
    return { state: "none" };
  }
  if (mine.status === "PAID") {
    return { state: "already", receiptNo: mine.payment?.receiptNo };
  }
  const result = await settleOnlinePayment(ctx.schoolId, reference);
  if (result.state === "booked" || result.state === "already") {
    revalidatePath(`/portal/${studentId}/fees`);
  }
  return { state: result.state, receiptNo: result.receiptNo };
}
