"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { PaymentMethod } from "@prisma/client";
import { requireRole } from "@/lib/auth";
import { PAYROLL, PAYROLL_APPROVE } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import {
  addPayItem,
  approveRun,
  confirmRateSet,
  createRun,
  deleteRateSet,
  deleteRun,
  markPaid,
  recalculateRun,
  reopenRun,
  saveAccounts,
  saveRateSet,
  saveStaffPay,
  setPayItem,
  setUpPayroll,
} from "@/lib/payroll-engine";
import { readAmount, readPayItem, readPeriod, readRateSet } from "@/lib/payroll-rules";

/**
 * Payroll's doors. Each runs `requireRole`, sets the tenant context in its own frame (a context set inside
 * `requireRole` does not reach here) and hands the real work to the engine.
 *
 * A refusal hands back what was typed (`values`): React resets a form when its action returns, and one bad amount must
 * not wipe the rest of what an accountant keyed in.
 */

export type PayrollState = { error?: string; ok?: string; values?: Record<string, string> };

function pick(formData: FormData, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, String(formData.get(key) ?? "")]));
}

const text = (formData: FormData, key: string) => String(formData.get(key) ?? "");

function done(result: { ok: string } | { error: string }, values?: Record<string, string>): PayrollState {
  revalidatePath("/payroll", "layout");
  return "error" in result ? { error: result.error, values } : { ok: result.ok };
}

/* ───────────────────────────── runs ───────────────────────────── */

export async function createRunAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["period", "note"]);

  const period = readPeriod(values.period!, new Date());
  if (!period.ok) return { error: period.error, values };
  const note = values.note!.trim().slice(0, 200) || null;

  const made = await createRun({ schoolId: auth.schoolId, userId: auth.userId }, period.year, period.month, note);
  if ("error" in made) return { error: made.error, values };
  revalidatePath("/payroll", "layout");
  redirect(`/payroll/${made.id}`);
}

export async function recalculateRunAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  return done(await recalculateRun({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "runId")));
}

export async function deleteRunAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const result = await deleteRun({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "runId"));
  if ("error" in result) return { error: result.error };
  revalidatePath("/payroll", "layout");
  redirect("/payroll");
}

export async function approveRunAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  return done(await approveRun({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "runId")));
}

export async function reopenRunAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  return done(await reopenRun({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "runId")));
}

export async function markPaidAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["runId", "paidOn", "method"]);

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(values.paidOn!);
  const paidOn = match ? new Date(`${match[0]}T00:00:00Z`) : null;
  if (!paidOn || Number.isNaN(paidOn.getTime())) return { error: "Choose the date the salaries were paid.", values };
  if (paidOn.getTime() > Date.now() + 24 * 60 * 60 * 1000) return { error: "That date has not come yet.", values };

  return done(await markPaid({ schoolId: auth.schoolId, userId: auth.userId }, values.runId!, paidOn, values.method as PaymentMethod), values);
}

/* ───────────────────────────── pay records ───────────────────────────── */

export async function saveStaffPayAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["staffId", "basic", "ssnitApplies"]);

  const basic = readAmount(values.basic!, "The basic salary");
  if (!basic.ok) return { error: basic.error, values };
  return done(await saveStaffPay({ schoolId: auth.schoolId, userId: auth.userId }, values.staffId!, basic.cedis, values.ssnitApplies !== "no"), values);
}

export async function addPayItemAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const values = pick(formData, ["staffId", "kind", "name", "amount", "taxable", "principal"]);

  const item = readPayItem(values);
  if (!item.ok) return { error: item.error, values };
  return done(await addPayItem({ schoolId: auth.schoolId, userId: auth.userId }, values.staffId!, item.value), values);
}

export async function setPayItemAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const change = text(formData, "change");
  if (change !== "stop" && change !== "resume" && change !== "remove") return { error: "Choose what to do with this item." };
  return done(await setPayItem({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "staffId"), text(formData, "itemId"), change));
}

/* ───────────────────────────── set-up ───────────────────────────── */

export async function setUpPayrollAction(): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  return done(await setUpPayroll({ schoolId: auth.schoolId, userId: auth.userId }));
}

export async function saveAccountsAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL);
  setTenantContext(auth.tenant);
  const values = pick(formData, [
    "payrollSalaryAccountId", "payrollPayeAccountId", "payrollSsnitAccountId", "payrollNetPayAccountId", "payrollAdvancesAccountId",
  ]);
  return done(await saveAccounts({ schoolId: auth.schoolId, userId: auth.userId }, values), values);
}

export async function saveRateSetAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  const values = pick(formData, [
    "id", "label", "effectiveFrom", "ssnitEmployeePercent", "ssnitEmployerPercent", "ssnitTier2Percent", "ssnitMaxInsurable", "taxBands",
  ]);
  const read = readRateSet(values);
  if (!read.ok) return { error: read.error, values };
  return done(await saveRateSet({ schoolId: auth.schoolId, userId: auth.userId }, values.id || null, read.value), values);
}

export async function confirmRateSetAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  return done(await confirmRateSet({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "id")));
}

export async function deleteRateSetAction(_prev: PayrollState, formData: FormData): Promise<PayrollState> {
  const auth = await requireRole(PAYROLL_APPROVE);
  setTenantContext(auth.tenant);
  return done(await deleteRateSet({ schoolId: auth.schoolId, userId: auth.userId }, text(formData, "id")));
}
