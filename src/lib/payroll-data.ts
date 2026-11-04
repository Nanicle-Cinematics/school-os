import "server-only";

import { prisma } from "@/lib/prisma";
import { computeAll } from "@/lib/payroll-engine";
import {
  bandsToText,
  ratesFrom,
  rateSetFor,
  stillOwed,
  sumRun,
  toPesewas,
  type RunTotals,
} from "@/lib/payroll-rules";

/**
 * What the payroll screens read. Every function here is a fixed handful of queries, awaited one after another: four
 * connections serve a page, and a run is a hundred people, not a hundred queries.
 *
 * Money leaves this file as PESEWAS (whole numbers) and screens format it, so a screen cannot do float arithmetic on
 * a salary by accident.
 */

const pesewas = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? 0 : toPesewas(value));

/* ───────────────────────────── the front page ───────────────────────────── */

export async function getPayrollOverview(schoolId: string) {
  const runs = await prisma.payrollRun.findMany({
    where: { schoolId },
    orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    select: { id: true, periodYear: true, periodMonth: true, status: true, approvedAt: true, paidOn: true, rateSet: { select: { label: true } } },
    take: 36,
  });
  const sums = runs.length
    ? await prisma.payslip.groupBy({
        by: ["runId"],
        where: { schoolId, runId: { in: runs.map((r) => r.id) } },
        _sum: { gross: true, net: true, paye: true },
        _count: { _all: true },
      })
    : [];
  const sumOf = new Map(sums.map((s) => [s.runId, s]));

  const rateSets = await prisma.payrollRateSet.findMany({ where: { schoolId }, select: { effectiveFrom: true, confirmedAt: true, label: true } });
  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId },
    select: { payrollSalaryAccountId: true, payrollPayeAccountId: true, payrollSsnitAccountId: true, payrollNetPayAccountId: true, payrollAdvancesAccountId: true },
  });
  const paid = await prisma.staffPay.count({ where: { schoolId, staff: { deletedAt: null, status: "ACTIVE" } } });
  const active = await prisma.staff.count({ where: { schoolId, deletedAt: null, status: "ACTIVE" } });

  return {
    runs: runs.map((r) => {
      const s = sumOf.get(r.id);
      return {
        ...r,
        people: s?._count._all ?? 0,
        gross: pesewas(s?._sum.gross),
        paye: pesewas(s?._sum.paye),
        net: pesewas(s?._sum.net),
      };
    }),
    setup: {
      rateSets: rateSets.length,
      confirmedRateSets: rateSets.filter((r) => r.confirmedAt).length,
      accountsMapped: Object.values(settings ?? {}).filter(Boolean).length,
      accountsNeeded: 5,
      staffPaid: paid,
      staffActive: active,
    },
  };
}

/* ───────────────────────────── a run ───────────────────────────── */

export async function getRun(schoolId: string, runId: string) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, schoolId },
    select: {
      id: true, periodYear: true, periodMonth: true, status: true, note: true, approvedAt: true, paidOn: true, rateSetId: true,
      rateSet: { select: { label: true, confirmedAt: true, effectiveFrom: true } },
    },
  });
  if (!run) return null;

  const payslips = await prisma.payslip.findMany({
    where: { runId },
    orderBy: [{ name: "asc" }],
    select: {
      id: true, staffId: true, staffNo: true, name: true, designation: true,
      basic: true, allowances: true, gross: true, ssnitEmployee: true, ssnitEmployer: true, ssnitTier2: true,
      paye: true, deductions: true, net: true, warnings: true,
    },
  });
  const rows = payslips.map((p) => ({
    id: p.id, staffId: p.staffId, staffNo: p.staffNo, name: p.name, designation: p.designation, warnings: p.warnings,
    basic: pesewas(p.basic), allowances: pesewas(p.allowances), gross: pesewas(p.gross),
    ssnitEmployee: pesewas(p.ssnitEmployee), ssnitEmployer: pesewas(p.ssnitEmployer), ssnitTier2: pesewas(p.ssnitTier2),
    paye: pesewas(p.paye), deductions: pesewas(p.deductions), net: pesewas(p.net),
  }));
  const totals: RunTotals = sumRun(rows);

  // Out of date? Only a draft can be: it holds figures worked out earlier, and the records may have moved since.
  let stale = false;
  if (run.status === "DRAFT") {
    const sets = await prisma.payrollRateSet.findMany({ where: { schoolId } });
    const set = rateSetFor(sets, run.periodYear, run.periodMonth);
    const rates = set ? ratesFrom(set) : null;
    if (!set || !rates || !rates.ok || set.id !== run.rateSetId) {
      stale = true;
    } else {
      const fresh = await computeAll(prisma, schoolId, rates.rates);
      const by = new Map(fresh.map((c) => [c.staffId, c.out]));
      stale =
        fresh.length !== rows.length ||
        rows.some((r) => {
          const f = by.get(r.staffId);
          return !f || f.gross !== r.gross || f.paye !== r.paye || f.ssnitEmployee !== r.ssnitEmployee || f.deductions !== r.deductions || f.net !== r.net;
        });
    }
  }

  // Who is on the staff list but not in this run, so a missing person is seen rather than discovered on pay day.
  const inRun = new Set(rows.map((r) => r.staffId));
  const staff = await prisma.staff.findMany({
    where: { schoolId, deletedAt: null, status: "ACTIVE" },
    select: { id: true, staffNo: true, firstName: true, lastName: true, pay: { select: { id: true } } },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });
  const missing = staff
    .filter((s) => !inRun.has(s.id))
    .map((s) => ({ id: s.id, staffNo: s.staffNo, name: `${s.firstName} ${s.lastName}`, hasPay: Boolean(s.pay) }));

  return { run, rows, totals, stale, missing };
}

/* ───────────────────────────── pay records ───────────────────────────── */

export async function getPayRecords(schoolId: string) {
  const staff = await prisma.staff.findMany({
    where: { schoolId, deletedAt: null, status: "ACTIVE" },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
    select: {
      id: true, staffNo: true, firstName: true, lastName: true, designation: true,
      pay: { select: { basicSalary: true, ssnitApplies: true } },
    },
  });
  const items = await prisma.staffPayItem.groupBy({
    by: ["staffId"],
    where: { schoolId, active: true },
    _count: { _all: true },
  });
  const count = new Map(items.map((i) => [i.staffId, i._count._all]));
  return staff.map((s) => ({
    id: s.id,
    staffNo: s.staffNo,
    name: `${s.firstName} ${s.lastName}`,
    designation: s.designation,
    basic: s.pay ? pesewas(s.pay.basicSalary) : null,
    ssnitApplies: s.pay?.ssnitApplies ?? true,
    items: count.get(s.id) ?? 0,
  }));
}

export async function getStaffPay(schoolId: string, staffId: string) {
  const staff = await prisma.staff.findFirst({
    where: { id: staffId, schoolId, deletedAt: null },
    select: {
      id: true, staffNo: true, firstName: true, lastName: true, designation: true, ssnitNumber: true, tin: true,
      pay: { select: { basicSalary: true, ssnitApplies: true } },
    },
  });
  if (!staff) return null;
  const items = await prisma.staffPayItem.findMany({
    where: { schoolId, staffId },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
    select: { id: true, kind: true, name: true, amount: true, taxable: true, principal: true, active: true },
  });
  const ids = items.filter((i) => i.kind === "DEDUCTION" && i.principal !== null).map((i) => i.id);
  const takenRows = ids.length
    ? await prisma.payslipLine.groupBy({
        by: ["payItemId"],
        where: { schoolId, kind: "DEDUCTION", payItemId: { in: ids }, payslip: { run: { status: { in: ["APPROVED", "PAID"] } } } },
        _sum: { amount: true },
      })
    : [];
  const taken = new Map(takenRows.map((r) => [r.payItemId, pesewas(r._sum.amount)]));
  return {
    staff: {
      id: staff.id, staffNo: staff.staffNo, name: `${staff.firstName} ${staff.lastName}`, designation: staff.designation,
      ssnitNumber: staff.ssnitNumber, tin: staff.tin,
    },
    pay: staff.pay ? { basic: pesewas(staff.pay.basicSalary), ssnitApplies: staff.pay.ssnitApplies } : null,
    items: items.map((i) => {
      const principal = i.principal === null ? null : pesewas(i.principal);
      return {
        id: i.id, kind: i.kind, name: i.name, taxable: i.taxable, active: i.active,
        amount: pesewas(i.amount),
        principal,
        owed: principal === null ? null : stillOwed({ principal, taken: taken.get(i.id) ?? 0 }),
      };
    }),
  };
}

/* ───────────────────────────── set-up ───────────────────────────── */

export async function getPayrollSetup(schoolId: string) {
  const sets = await prisma.payrollRateSet.findMany({
    where: { schoolId },
    orderBy: { effectiveFrom: "desc" },
    select: {
      id: true, label: true, effectiveFrom: true, confirmedAt: true, taxBands: true,
      ssnitEmployeePercent: true, ssnitEmployerPercent: true, ssnitTier2Percent: true, ssnitMaxInsurable: true,
      _count: { select: { runs: true } },
    },
  });
  const accounts = await prisma.ledgerAccount.findMany({
    where: { schoolId, isActive: true },
    orderBy: [{ order: "asc" }, { code: "asc" }],
    select: { id: true, code: true, name: true, type: true },
  });
  const settings = await prisma.schoolSettings.findUnique({
    where: { schoolId },
    select: { payrollSalaryAccountId: true, payrollPayeAccountId: true, payrollSsnitAccountId: true, payrollNetPayAccountId: true, payrollAdvancesAccountId: true },
  });
  return {
    sets: sets.map((s) => ({
      id: s.id,
      label: s.label,
      effectiveFrom: s.effectiveFrom,
      confirmed: Boolean(s.confirmedAt),
      runs: s._count.runs,
      employee: Number(s.ssnitEmployeePercent),
      employer: Number(s.ssnitEmployerPercent),
      tier2: Number(s.ssnitTier2Percent),
      maxInsurable: Number(s.ssnitMaxInsurable),
      bandsText: Array.isArray(s.taxBands) ? bandsToText(s.taxBands as { width: number | null; rate: number }[]) : "",
    })),
    accounts,
    mapping: {
      salary: settings?.payrollSalaryAccountId ?? "",
      paye: settings?.payrollPayeAccountId ?? "",
      ssnit: settings?.payrollSsnitAccountId ?? "",
      netPay: settings?.payrollNetPayAccountId ?? "",
      advances: settings?.payrollAdvancesAccountId ?? "",
    },
  };
}

/* ───────────────────────────── paper ───────────────────────────── */

/** The payslips of a run, whole, for printing: one person or everyone. */
export async function getPayslips(schoolId: string, runId: string, staffId?: string) {
  const run = await prisma.payrollRun.findFirst({
    where: { id: runId, schoolId },
    select: { id: true, periodYear: true, periodMonth: true, status: true, paidOn: true, rateSet: { select: { label: true } } },
  });
  if (!run) return null;
  const slips = await prisma.payslip.findMany({
    where: { runId, ...(staffId ? { staffId } : {}) },
    orderBy: { name: "asc" },
    include: { lines: { orderBy: [{ kind: "asc" }, { name: "asc" }] } },
  });
  return {
    run,
    slips: slips.map((p) => ({
      id: p.id, staffId: p.staffId, staffNo: p.staffNo, name: p.name, designation: p.designation, ssnitNumber: p.ssnitNumber, tin: p.tin,
      basic: pesewas(p.basic), allowances: pesewas(p.allowances), gross: pesewas(p.gross), ssnitBase: pesewas(p.ssnitBase),
      ssnitEmployee: pesewas(p.ssnitEmployee), ssnitEmployer: pesewas(p.ssnitEmployer), ssnitTier2: pesewas(p.ssnitTier2),
      taxableIncome: pesewas(p.taxableIncome), chargeable: pesewas(p.chargeable), paye: pesewas(p.paye),
      deductions: pesewas(p.deductions), net: pesewas(p.net), warnings: p.warnings,
      lines: p.lines.map((l) => ({ id: l.id, kind: l.kind, name: l.name, amount: pesewas(l.amount), taxable: l.taxable })),
    })),
  };
}

export type RunView = NonNullable<Awaited<ReturnType<typeof getRun>>>;
export type PayslipsView = NonNullable<Awaited<ReturnType<typeof getPayslips>>>;
export type PayslipView = PayslipsView["slips"][number];
