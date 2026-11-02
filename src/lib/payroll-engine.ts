import "server-only";

import { Prisma, type PaymentMethod } from "@prisma/client";
import { writeAudit } from "@/lib/audit";
import { lockOn } from "@/lib/locks";
import { cashAccountIdForMethod, findJournalEntryForSource, getCoreAccounts, postJournalEntry, reverseJournalEntry } from "@/lib/ledger-engine";
import { ownsLedgerAccounts, ownsStaff } from "@/lib/ownership";
import { prisma, tenantTransaction, type TenantTx } from "@/lib/prisma";
import {
  STARTING_RATES,
  canMoveRun,
  computePayslip,
  fromPesewas,
  payrollEntry,
  periodLabel,
  readBands,
  rateSetFor,
  ratesFrom,
  sumRun,
  toPesewas,
  type PayItemValue,
  type PayslipOut,
  type RateSetValue,
  type Rates,
  type PayrollAccounts,
} from "@/lib/payroll-rules";

/**
 * Everything that changes payroll. The caller has run `requireRole` and set the tenant context; not a "use server"
 * module, because every export of one is a callable endpoint and these take the school as an argument.
 *
 * Three rules shape it, each learnt from how this app already handles money:
 *
 *  - A payslip is FROZEN when it is worked out, with the person's details beside it, and a run is approved on the
 *    numbers it holds. So approving first works the month out again from today's records and refuses if it no longer
 *    agrees: a salary edited after the run was calculated must not be paid at the old figure unseen.
 *  - What a loan still owes is DERIVED from the lines of approved runs (never a stored balance), so reopening a run
 *    puts its instalments back.
 *  - Posting to the ledger is best-effort and additive, like every other posting here: a school that has not mapped
 *    its payroll accounts approves the run and is told the accounts were not written.
 *
 * Audit rows carry no salaries and no names: the audit trail is read more widely than payroll is.
 */

export type Actor = { schoolId: string; userId: string };
export type Done = { ok: string };
export type Refused = { error: string };

type Db = Pick<TenantTx, "staffPay" | "staffPayItem" | "payslipLine" | "payslip">;

/* ───────────────────────────── working a month out ───────────────────────────── */

export type Computed = {
  staffId: string;
  staffNo: string;
  name: string;
  designation: string | null;
  ssnitNumber: string | null;
  tin: string | null;
  out: PayslipOut;
};

/**
 * Everyone who is paid, worked out. A person is paid when they are an ACTIVE, not-removed member of staff with a pay
 * record; anyone else is simply not in the run (and the pay page says who is missing). Reads in sequence: four
 * connections serve a whole page.
 */
export async function computeAll(db: Db, schoolId: string, rates: Rates): Promise<Computed[]> {
  const pays = await db.staffPay.findMany({
    where: { schoolId, staff: { deletedAt: null, status: "ACTIVE" } },
    select: {
      basicSalary: true,
      ssnitApplies: true,
      staff: {
        select: { id: true, staffNo: true, firstName: true, middleName: true, lastName: true, designation: true, ssnitNumber: true, tin: true },
      },
    },
    orderBy: [{ staff: { lastName: "asc" } }, { staff: { firstName: "asc" } }],
  });
  const staffIds = pays.map((p) => p.staff.id);
  const items = await db.staffPayItem.findMany({
    where: { schoolId, active: true, staffId: { in: staffIds } },
    orderBy: { createdAt: "asc" },
    select: { id: true, staffId: true, kind: true, name: true, amount: true, taxable: true, principal: true },
  });

  const deductionIds = items.filter((i) => i.kind === "DEDUCTION" && i.principal !== null).map((i) => i.id);
  const takenRows = deductionIds.length
    ? await db.payslipLine.groupBy({
        by: ["payItemId"],
        where: { schoolId, kind: "DEDUCTION", payItemId: { in: deductionIds }, payslip: { run: { status: { in: ["APPROVED", "PAID"] } } } },
        _sum: { amount: true },
      })
    : [];
  const taken = new Map(takenRows.map((r) => [r.payItemId, toPesewas(r._sum.amount ?? 0)]));

  return pays.map((pay) => {
    const mine = items.filter((i) => i.staffId === pay.staff.id);
    const out = computePayslip(
      {
        basic: toPesewas(pay.basicSalary),
        ssnitApplies: pay.ssnitApplies,
        items: mine.map((i) => ({
          id: i.id,
          kind: i.kind,
          name: i.name,
          amount: toPesewas(i.amount),
          taxable: i.taxable,
          principal: i.principal === null ? null : toPesewas(i.principal),
          taken: taken.get(i.id) ?? 0,
        })),
      },
      rates,
    );
    const s = pay.staff;
    return {
      staffId: s.id,
      staffNo: s.staffNo,
      name: [s.firstName, s.middleName, s.lastName].filter(Boolean).join(" "),
      designation: s.designation,
      ssnitNumber: s.ssnitNumber,
      tin: s.tin,
      out,
    };
  });
}

const cedis = (pesewas: number) => new Prisma.Decimal(fromPesewas(pesewas));

/** Replace a draft run's payslips with a fresh working-out. Returns how many people it holds. */
async function fillPayslips(tx: TenantTx, schoolId: string, runId: string, rates: Rates): Promise<number> {
  const computed = await computeAll(tx, schoolId, rates);
  await tx.payslip.deleteMany({ where: { runId } });
  if (computed.length === 0) return 0;

  const created = await tx.payslip.createManyAndReturn({
    data: computed.map((c) => ({
      schoolId,
      runId,
      staffId: c.staffId,
      staffNo: c.staffNo,
      name: c.name,
      designation: c.designation,
      ssnitNumber: c.ssnitNumber,
      tin: c.tin,
      basic: cedis(c.out.basic),
      allowances: cedis(c.out.allowances),
      gross: cedis(c.out.gross),
      ssnitBase: cedis(c.out.ssnitBase),
      ssnitEmployee: cedis(c.out.ssnitEmployee),
      ssnitEmployer: cedis(c.out.ssnitEmployer),
      ssnitTier2: cedis(c.out.ssnitTier2),
      taxableIncome: cedis(c.out.taxableIncome),
      chargeable: cedis(c.out.chargeable),
      paye: cedis(c.out.paye),
      deductions: cedis(c.out.deductions),
      net: cedis(c.out.net),
      warnings: c.out.warnings.length ? c.out.warnings.join("\n") : null,
    })),
    select: { id: true, staffId: true },
  });
  const idOf = new Map(created.map((p) => [p.staffId, p.id]));
  const lines = computed.flatMap((c) =>
    c.out.lines.map((l) => ({
      schoolId,
      payslipId: idOf.get(c.staffId)!,
      payItemId: l.payItemId,
      kind: l.kind,
      name: l.name,
      amount: cedis(l.amount),
      taxable: l.taxable,
    })),
  );
  if (lines.length) await tx.payslipLine.createMany({ data: lines });
  return computed.length;
}

/* ───────────────────────────── rates ───────────────────────────── */

/** The rates that apply to a month, or the sentence saying why none do. */
async function ratesForMonth(db: Pick<TenantTx, "payrollRateSet">, schoolId: string, year: number, month: number) {
  const sets = await db.payrollRateSet.findMany({ where: { schoolId } });
  const set = rateSetFor(sets, year, month);
  if (!set) {
    return { error: `No pay rates apply to ${periodLabel(year, month)}. Add rates that start on or before it under Set-up.` } as Refused;
  }
  const rates = ratesFrom(set);
  if (!rates.ok) return { error: `The rates set for ${set.label} cannot be read: ${rates.error}` } as Refused;
  return { set, rates: rates.rates };
}

/* ───────────────────────────── setting up ───────────────────────────── */

const PAYROLL_ACCOUNTS = [
  { code: "PAY_SALARIES", name: "Salaries and wages", type: "EXPENSE" as const, order: 300, key: "payrollSalaryAccountId" as const },
  { code: "PAY_PAYE", name: "PAYE payable (GRA)", type: "LIABILITY" as const, order: 301, key: "payrollPayeAccountId" as const },
  { code: "PAY_SSNIT", name: "SSNIT payable", type: "LIABILITY" as const, order: 302, key: "payrollSsnitAccountId" as const },
  { code: "PAY_NET", name: "Net salaries payable", type: "LIABILITY" as const, order: 303, key: "payrollNetPayAccountId" as const },
  { code: "PAY_ADVANCES", name: "Staff advances and loans", type: "ASSET" as const, order: 304, key: "payrollAdvancesAccountId" as const },
];

/**
 * Give a school what payroll needs to start, as a starting point and idempotent: the five accounts (made if their
 * code is free, and mapped only where the school has not mapped one itself) and the starting rate set (made only
 * when the school has none). It never touches a mapping or a rate set the school already has.
 */
export async function setUpPayroll(actor: Actor): Promise<Done> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const existing = await tx.ledgerAccount.findMany({
      where: { schoolId: actor.schoolId, code: { in: PAYROLL_ACCOUNTS.map((a) => a.code) } },
      select: { id: true, code: true },
    });
    const have = new Set(existing.map((a) => a.code));
    const missing = PAYROLL_ACCOUNTS.filter((a) => !have.has(a.code));
    if (missing.length) {
      await tx.ledgerAccount.createMany({
        data: missing.map((a) => ({ schoolId: actor.schoolId, code: a.code, name: a.name, type: a.type, order: a.order })),
      });
    }
    const accounts = await tx.ledgerAccount.findMany({
      where: { schoolId: actor.schoolId, code: { in: PAYROLL_ACCOUNTS.map((a) => a.code) } },
      select: { id: true, code: true },
    });
    const idOf = new Map(accounts.map((a) => [a.code, a.id]));

    const settings = await tx.schoolSettings.findUnique({
      where: { schoolId: actor.schoolId },
      select: { payrollSalaryAccountId: true, payrollPayeAccountId: true, payrollSsnitAccountId: true, payrollNetPayAccountId: true, payrollAdvancesAccountId: true },
    });
    const mapping: Partial<Record<(typeof PAYROLL_ACCOUNTS)[number]["key"], string>> = {};
    for (const a of PAYROLL_ACCOUNTS) {
      if (!settings?.[a.key] && idOf.get(a.code)) mapping[a.key] = idOf.get(a.code)!;
    }
    if (Object.keys(mapping).length) {
      await tx.schoolSettings.upsert({
        where: { schoolId: actor.schoolId },
        create: { schoolId: actor.schoolId, ...mapping },
        update: mapping,
      });
    }

    const sets = await tx.payrollRateSet.count({ where: { schoolId: actor.schoolId } });
    let madeRates = false;
    if (sets === 0) {
      await tx.payrollRateSet.create({
        data: {
          schoolId: actor.schoolId,
          label: STARTING_RATES.label,
          effectiveFrom: new Date(`${STARTING_RATES.effectiveFrom}T00:00:00Z`),
          ssnitEmployeePercent: STARTING_RATES.ssnitEmployeePercent,
          ssnitEmployerPercent: STARTING_RATES.ssnitEmployerPercent,
          ssnitTier2Percent: STARTING_RATES.ssnitTier2Percent,
          ssnitMaxInsurable: STARTING_RATES.ssnitMaxInsurable,
          taxBands: STARTING_RATES.taxBands,
        },
      });
      madeRates = true;
    }

    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "payroll.setup",
      entity: "PayrollRateSet",
      entityId: actor.schoolId,
      after: { accountsCreated: missing.length, accountsMapped: Object.keys(mapping).length, ratesCreated: madeRates },
    });

    const parts = [
      missing.length ? `${missing.length} ${missing.length === 1 ? "account" : "accounts"} added` : null,
      Object.keys(mapping).length ? `${Object.keys(mapping).length} mapped` : null,
      madeRates ? "starting rates added (check them before the first run)" : null,
    ].filter(Boolean);
    return { ok: parts.length ? `Payroll set up: ${parts.join(", ")}.` : "Payroll was already set up; nothing changed." };
  });
}

export async function saveAccounts(actor: Actor, mapping: Record<string, string | null>): Promise<Done | Refused> {
  const clean: Record<"payrollSalaryAccountId" | "payrollPayeAccountId" | "payrollSsnitAccountId" | "payrollNetPayAccountId" | "payrollAdvancesAccountId", string | null> = {
    payrollSalaryAccountId: mapping.payrollSalaryAccountId || null,
    payrollPayeAccountId: mapping.payrollPayeAccountId || null,
    payrollSsnitAccountId: mapping.payrollSsnitAccountId || null,
    payrollNetPayAccountId: mapping.payrollNetPayAccountId || null,
    payrollAdvancesAccountId: mapping.payrollAdvancesAccountId || null,
  };
  // Plain ids with no foreign key: nothing at the database would object to another school's account.
  if (!(await ownsLedgerAccounts(Object.values(clean)))) {
    return { error: "One of those accounts is not in this school's chart of accounts." };
  }
  await tenantTransaction(actor.schoolId, async (tx) => {
    await tx.schoolSettings.upsert({
      where: { schoolId: actor.schoolId },
      create: { schoolId: actor.schoolId, ...clean },
      update: clean,
    });
    await writeAudit(tx, {
      schoolId: actor.schoolId,
      actorUserId: actor.userId,
      action: "payroll.accounts",
      entity: "SchoolSettings",
      entityId: actor.schoolId,
      after: { mapped: Object.values(clean).filter(Boolean).length },
    });
  });
  return { ok: "Payroll accounts saved." };
}

/** Add or edit a rate set. One a run has used is frozen, and an edit takes back any confirmation. */
export async function saveRateSet(actor: Actor, id: string | null, value: RateSetValue): Promise<Done | Refused> {
  const data = {
    label: value.label,
    effectiveFrom: new Date(`${value.effectiveFrom}T00:00:00Z`),
    ssnitEmployeePercent: value.ssnitEmployeePercent,
    ssnitEmployerPercent: value.ssnitEmployerPercent,
    ssnitTier2Percent: value.ssnitTier2Percent,
    ssnitMaxInsurable: value.ssnitMaxInsurable,
    taxBands: value.taxBands,
    confirmedAt: null,
  };
  return tenantTransaction(actor.schoolId, async (tx) => {
    const clash = await tx.payrollRateSet.findFirst({
      where: { schoolId: actor.schoolId, effectiveFrom: data.effectiveFrom, ...(id ? { id: { not: id } } : {}) },
      select: { label: true },
    });
    if (clash) return { error: `"${clash.label}" already starts on that date. Change that one, or choose another date.` };

    if (id) {
      const current = await tx.payrollRateSet.findFirst({ where: { id, schoolId: actor.schoolId }, select: { id: true } });
      if (!current) return { error: "Those rates were not found." };
      const used = await tx.payrollRun.count({ where: { rateSetId: id } });
      if (used > 0) {
        return { error: `A payroll run has already used these rates, so they cannot be changed. Add new rates with a later start date instead.` };
      }
      await tx.payrollRateSet.update({ where: { id }, data });
      await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.rates", entity: "PayrollRateSet", entityId: id, after: { edited: true } });
      return { ok: "Rates saved. They need confirming again before a run can be approved on them." };
    }
    const made = await tx.payrollRateSet.create({ data: { schoolId: actor.schoolId, ...data }, select: { id: true } });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.rates", entity: "PayrollRateSet", entityId: made.id, after: { edited: false } });
    return { ok: "Rates added. Confirm them once they have been checked against GRA and SSNIT." };
  });
}

export async function confirmRateSet(actor: Actor, id: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const set = await tx.payrollRateSet.findFirst({ where: { id, schoolId: actor.schoolId }, select: { id: true, confirmedAt: true, taxBands: true } });
    if (!set) return { error: "Those rates were not found." };
    const readable = readBands(set.taxBands);
    if (!readable.ok) return { error: `These rates cannot be confirmed: ${readable.error}` };
    if (set.confirmedAt) return { ok: "Those rates were already confirmed." };
    await tx.payrollRateSet.update({ where: { id }, data: { confirmedAt: new Date() } });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.rates.confirm", entity: "PayrollRateSet", entityId: id });
    return { ok: "Rates confirmed." };
  });
}

export async function deleteRateSet(actor: Actor, id: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const set = await tx.payrollRateSet.findFirst({ where: { id, schoolId: actor.schoolId }, select: { id: true } });
    if (!set) return { error: "Those rates were not found." };
    if ((await tx.payrollRun.count({ where: { rateSetId: id } })) > 0) {
      return { error: "A payroll run has used these rates, so they stay on record." };
    }
    await tx.payrollRateSet.delete({ where: { id } });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.rates.delete", entity: "PayrollRateSet", entityId: id });
    return { ok: "Rates removed." };
  });
}

/* ───────────────────────────── what each person is paid ───────────────────────────── */

export async function saveStaffPay(actor: Actor, staffId: string, basicCedis: number, ssnitApplies: boolean): Promise<Done | Refused> {
  if (!(await ownsStaff([staffId]))) return { error: "That member of staff was not found." };
  return tenantTransaction(actor.schoolId, async (tx) => {
    const person = await tx.staff.findFirst({ where: { id: staffId, schoolId: actor.schoolId, deletedAt: null }, select: { id: true } });
    if (!person) return { error: "That member of staff was not found." };
    await tx.staffPay.upsert({
      where: { staffId },
      create: { schoolId: actor.schoolId, staffId, basicSalary: basicCedis, ssnitApplies },
      update: { basicSalary: basicCedis, ssnitApplies },
    });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.staffPay", entity: "Staff", entityId: staffId, after: { ssnitApplies } });
    return { ok: "Pay saved. A run already started does not change until it is recalculated." };
  });
}

export async function addPayItem(actor: Actor, staffId: string, item: PayItemValue): Promise<Done | Refused> {
  if (!(await ownsStaff([staffId]))) return { error: "That member of staff was not found." };
  return tenantTransaction(actor.schoolId, async (tx) => {
    const pay = await tx.staffPay.findFirst({ where: { staffId, schoolId: actor.schoolId }, select: { id: true } });
    if (!pay) return { error: "Set this person's basic salary first." };
    const made = await tx.staffPayItem.create({
      data: {
        schoolId: actor.schoolId,
        staffId,
        kind: item.kind,
        name: item.name,
        amount: item.amount,
        taxable: item.taxable,
        principal: item.principal,
      },
      select: { id: true },
    });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.item", entity: "StaffPayItem", entityId: made.id, after: { kind: item.kind, change: "added" } });
    return { ok: `${item.kind === "ALLOWANCE" ? "Allowance" : "Deduction"} added.` };
  });
}

export async function setPayItem(actor: Actor, staffId: string, itemId: string, change: "stop" | "resume" | "remove"): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    const where = { id: itemId, staffId, schoolId: actor.schoolId };
    const item = await tx.staffPayItem.findFirst({ where, select: { id: true, kind: true } });
    if (!item) return { error: "That item was not found." };
    if (change === "remove") {
      await tx.staffPayItem.deleteMany({ where });
    } else {
      await tx.staffPayItem.updateMany({ where, data: { active: change === "resume" } });
    }
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.item", entity: "StaffPayItem", entityId: itemId, after: { kind: item.kind, change } });
    return { ok: change === "remove" ? "Item removed." : change === "stop" ? "Item stopped. It is left out of the next run." : "Item resumed." };
  });
}

/* ───────────────────────────── a run ───────────────────────────── */

export async function createRun(actor: Actor, year: number, month: number, note: string | null): Promise<(Done & { id: string }) | Refused> {
  const found = await prisma.payrollRun.findUnique({
    where: { schoolId_periodYear_periodMonth: { schoolId: actor.schoolId, periodYear: year, periodMonth: month } },
    select: { id: true, status: true },
  });
  if (found) return { error: `${periodLabel(year, month)} already has a payroll run (${found.status.toLowerCase()}).` };

  const picked = await ratesForMonth(prisma, actor.schoolId, year, month);
  if ("error" in picked) return picked;

  try {
    return await tenantTransaction(actor.schoolId, async (tx) => {
      await lockOn(tx, `payroll:${actor.schoolId}`);
      const run = await tx.payrollRun.create({
        data: { schoolId: actor.schoolId, periodYear: year, periodMonth: month, rateSetId: picked.set.id, note },
        select: { id: true },
      });
      const people = await fillPayslips(tx, actor.schoolId, run.id, picked.rates);
      if (people === 0) {
        // Nothing to pay: roll the whole thing back rather than leave an empty run holding the month.
        throw new NothingToPay();
      }
      await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.create", entity: "PayrollRun", entityId: run.id, after: { period: `${year}-${month}`, people } });
      return { ok: `${periodLabel(year, month)} worked out for ${people} ${people === 1 ? "person" : "people"}.`, id: run.id };
    });
  } catch (error) {
    if (error instanceof NothingToPay) {
      return { error: "No active staff have a pay record yet. Set each person's basic salary under Pay records first." };
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { error: `${periodLabel(year, month)} already has a payroll run.` };
    }
    throw error;
  }
}

class NothingToPay extends Error {}

type RunRow = { id: string; status: "DRAFT" | "APPROVED" | "PAID"; periodYear: number; periodMonth: number; rateSetId: string };

async function loadRun(tx: TenantTx, schoolId: string, runId: string): Promise<RunRow | null> {
  return tx.payrollRun.findFirst({
    where: { id: runId, schoolId },
    select: { id: true, status: true, periodYear: true, periodMonth: true, rateSetId: true },
  });
}

export async function recalculateRun(actor: Actor, runId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    await lockOn(tx, `payroll:${runId}`);
    const run = await loadRun(tx, actor.schoolId, runId);
    if (!run) return { error: "That payroll run was not found." };
    if (run.status !== "DRAFT") return { error: "Only a draft run can be recalculated. Reopen it first." };
    const picked = await ratesForMonth(tx, actor.schoolId, run.periodYear, run.periodMonth);
    if ("error" in picked) return picked;
    if (picked.set.id !== run.rateSetId) {
      await tx.payrollRun.update({ where: { id: runId }, data: { rateSetId: picked.set.id } });
    }
    const people = await fillPayslips(tx, actor.schoolId, runId, picked.rates);
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.recalculate", entity: "PayrollRun", entityId: runId, after: { people } });
    return { ok: `Worked out again for ${people} ${people === 1 ? "person" : "people"}.` };
  });
}

export async function deleteRun(actor: Actor, runId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    await lockOn(tx, `payroll:${runId}`);
    const run = await loadRun(tx, actor.schoolId, runId);
    if (!run) return { error: "That payroll run was not found." };
    if (run.status !== "DRAFT") return { error: "Only a draft run can be deleted." };
    await tx.payrollRun.delete({ where: { id: runId } });
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.delete", entity: "PayrollRun", entityId: runId, after: { period: `${run.periodYear}-${run.periodMonth}` } });
    return { ok: "The draft run was deleted." };
  });
}

/** The accounts a run posts to, as the school mapped them. */
async function payrollAccounts(tx: TenantTx, schoolId: string): Promise<PayrollAccounts> {
  const s = await tx.schoolSettings.findUnique({
    where: { schoolId },
    select: { payrollSalaryAccountId: true, payrollPayeAccountId: true, payrollSsnitAccountId: true, payrollNetPayAccountId: true, payrollAdvancesAccountId: true },
  });
  return {
    salary: s?.payrollSalaryAccountId ?? null,
    paye: s?.payrollPayeAccountId ?? null,
    ssnit: s?.payrollSsnitAccountId ?? null,
    netPay: s?.payrollNetPayAccountId ?? null,
    advances: s?.payrollAdvancesAccountId ?? null,
  };
}

const REVERSAL = "Reversal: ";

/** Has this run's approval left a LIVE posting, i.e. its latest entry exists and is not a reversal? */
async function livePosting(tx: TenantTx, schoolId: string, runId: string) {
  const entry = await findJournalEntryForSource(tx, schoolId, "PAYROLL", runId);
  return entry && !entry.memo.startsWith(REVERSAL) ? entry : null;
}

/**
 * Approve a draft: refused unless its rates are confirmed and it still agrees with today's records, then posted to
 * the accounts if they are mapped. The status moves with a conditional update, so two heads pressing it both get an
 * answer and only one posts.
 */
export async function approveRun(actor: Actor, runId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    await lockOn(tx, `payroll:${runId}`);
    const run = await loadRun(tx, actor.schoolId, runId);
    if (!run) return { error: "That payroll run was not found." };
    if (!canMoveRun(run.status, "APPROVED")) return { error: run.status === "APPROVED" ? "This run is already approved." : "This run is already paid." };

    const picked = await ratesForMonth(tx, actor.schoolId, run.periodYear, run.periodMonth);
    if ("error" in picked) return picked;
    if (picked.set.id !== run.rateSetId) {
      return { error: "Newer pay rates apply to this month than the ones the run was worked out on. Recalculate it first." };
    }
    if (!picked.set.confirmedAt) {
      return { error: `The rates "${picked.set.label}" have not been confirmed. Check them against GRA and SSNIT under Set-up, then confirm them.` };
    }

    const stored = await tx.payslip.findMany({
      where: { runId },
      select: { staffId: true, gross: true, ssnitEmployee: true, ssnitEmployer: true, ssnitTier2: true, paye: true, deductions: true, net: true, basic: true, allowances: true },
    });
    if (stored.length === 0) return { error: "This run has nobody in it." };

    const fresh = await computeAll(tx, actor.schoolId, picked.rates);
    const freshBy = new Map(fresh.map((c) => [c.staffId, c.out]));
    const drifted =
      fresh.length !== stored.length ||
      stored.some((s) => {
        const f = freshBy.get(s.staffId);
        return (
          !f ||
          f.gross !== toPesewas(s.gross) ||
          f.ssnitEmployee !== toPesewas(s.ssnitEmployee) ||
          f.paye !== toPesewas(s.paye) ||
          f.deductions !== toPesewas(s.deductions) ||
          f.net !== toPesewas(s.net)
        );
      });
    if (drifted) {
      return { error: "Pay records or rates have changed since this run was worked out, so what it shows is out of date. Recalculate it, check it, then approve." };
    }

    const moved = await tx.payrollRun.updateMany({ where: { id: runId, status: "DRAFT" }, data: { status: "APPROVED", approvedAt: new Date() } });
    if (moved.count !== 1) return { error: "This run was approved a moment ago by someone else." };

    const totals = sumRun(
      stored.map((s) => ({
        basic: toPesewas(s.basic), allowances: toPesewas(s.allowances), gross: toPesewas(s.gross),
        ssnitEmployee: toPesewas(s.ssnitEmployee), ssnitEmployer: toPesewas(s.ssnitEmployer), ssnitTier2: toPesewas(s.ssnitTier2),
        paye: toPesewas(s.paye), deductions: toPesewas(s.deductions), net: toPesewas(s.net),
      })),
    );
    const entry = payrollEntry(totals, await payrollAccounts(tx, actor.schoolId));
    const label = periodLabel(run.periodYear, run.periodMonth);
    let posted = false;
    if (entry.ok && entry.lines.length > 0) {
      await postJournalEntry(tx, actor.schoolId, {
        sourceType: "PAYROLL",
        sourceId: runId,
        memo: `Payroll ${label}`,
        actorUserId: actor.userId,
        lines: entry.lines.map((l) => ({
          accountId: l.accountId,
          debit: l.debit === undefined ? undefined : cedis(l.debit),
          credit: l.credit === undefined ? undefined : cedis(l.credit),
          description: l.description,
        })),
      });
      posted = true;
    }
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.approve", entity: "PayrollRun", entityId: runId, after: { period: `${run.periodYear}-${run.periodMonth}`, people: totals.people, posted } });

    return {
      ok: posted
        ? `${label} approved and posted to the accounts.`
        : `${label} approved. It was NOT posted to the accounts: ${entry.ok ? "there was nothing to post" : `map ${entry.missing.join(", ")} under Set-up`}.`,
    };
  });
}

/** Take an approved run back to a draft, reversing what it posted. A paid run cannot be reopened. */
export async function reopenRun(actor: Actor, runId: string): Promise<Done | Refused> {
  return tenantTransaction(actor.schoolId, async (tx) => {
    await lockOn(tx, `payroll:${runId}`);
    const run = await loadRun(tx, actor.schoolId, runId);
    if (!run) return { error: "That payroll run was not found." };
    if (!canMoveRun(run.status, "DRAFT")) {
      return { error: run.status === "PAID" ? "A paid run cannot be reopened: the money has gone." : "Only an approved run can be reopened." };
    }
    const moved = await tx.payrollRun.updateMany({ where: { id: runId, status: "APPROVED" }, data: { status: "DRAFT", approvedAt: null } });
    if (moved.count !== 1) return { error: "This run changed a moment ago. Open it again to see where it stands." };

    const live = await livePosting(tx, actor.schoolId, runId);
    if (live) {
      await reverseJournalEntry(tx, actor.schoolId, live.id, { memo: `${REVERSAL}${live.memo}`, actorUserId: actor.userId });
    }
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.reopen", entity: "PayrollRun", entityId: runId, after: { reversed: Boolean(live) } });
    return { ok: live ? "Reopened as a draft. What it posted to the accounts was reversed." : "Reopened as a draft." };
  });
}

export const PAY_METHODS: PaymentMethod[] = ["BANK_TRANSFER", "MOBILE_MONEY", "CASH"];

/** Mark an approved run paid, and move the net pay out of the accounts if the approval posted it. */
export async function markPaid(actor: Actor, runId: string, paidOn: Date, method: PaymentMethod): Promise<Done | Refused> {
  if (!PAY_METHODS.includes(method)) return { error: "Choose how the salaries were paid." };
  return tenantTransaction(actor.schoolId, async (tx) => {
    await lockOn(tx, `payroll:${runId}`);
    const run = await loadRun(tx, actor.schoolId, runId);
    if (!run) return { error: "That payroll run was not found." };
    if (!canMoveRun(run.status, "PAID")) return { error: run.status === "PAID" ? "This run is already marked paid." : "Approve the run before marking it paid." };

    const moved = await tx.payrollRun.updateMany({ where: { id: runId, status: "APPROVED" }, data: { status: "PAID", paidOn } });
    if (moved.count !== 1) return { error: "This run changed a moment ago. Open it again to see where it stands." };

    const label = periodLabel(run.periodYear, run.periodMonth);
    let posted = false;
    const live = await livePosting(tx, actor.schoolId, runId);
    if (live) {
      const accounts = await payrollAccounts(tx, actor.schoolId);
      const from = cashAccountIdForMethod(await getCoreAccounts(tx, actor.schoolId), method);
      const net = await tx.payslip.aggregate({ where: { runId }, _sum: { net: true } });
      const amount = toPesewas(net._sum.net ?? 0);
      if (accounts.netPay && from && amount > 0) {
        await postJournalEntry(tx, actor.schoolId, {
          sourceType: "PAYROLL_PAYMENT",
          sourceId: runId,
          memo: `Salaries paid ${label}`,
          actorUserId: actor.userId,
          lines: [
            { accountId: accounts.netPay, debit: cedis(amount), description: "Net salaries paid" },
            { accountId: from, credit: cedis(amount), description: "Paid out" },
          ],
        });
        posted = true;
      }
    }
    await writeAudit(tx, { schoolId: actor.schoolId, actorUserId: actor.userId, action: "payroll.pay", entity: "PayrollRun", entityId: runId, after: { method, posted } });
    return {
      ok: posted
        ? `${label} marked paid and the payment recorded in the accounts.`
        : `${label} marked paid. The payment was not recorded in the accounts${live ? ": map the account the money left from" : " because the approval did not post"}.`,
    };
  });
}
