/**
 * The rules of payroll, and nothing else: no database, no `server-only`, so the engine, the screens and the guard
 * all call the SAME functions. Everything money-shaped here is an integer count of PESEWAS. A float never touches a
 * salary: 17.5% of GH¢2,900 is exact in whole pesewas and not in binary floating point.
 *
 * What is NOT here is any statute. The PAYE bands, the SSNIT percentages and the insurable ceiling are DATA, held
 * per school in `PayrollRateSet` and handed to these functions. They changed on 1 September 2026 (Act 1178), and a
 * rate written into code is a deploy the next time they do.
 */

/* ───────────────────────────── money ───────────────────────────── */

/** A decimal string, number or Prisma Decimal in cedis, to whole pesewas. */
export function toPesewas(value: { toString(): string } | number): number {
  const n = typeof value === "number" ? value : Number(value.toString());
  return Math.round(n * 100);
}

export function fromPesewas(pesewas: number): string {
  const sign = pesewas < 0 ? "-" : "";
  const abs = Math.abs(Math.round(pesewas));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** Basis points of an amount, half rounded UP, in integers: 550 bp of 100000 is 5500 exactly. */
export function ofBasisPoints(pesewas: number, basisPoints: number): number {
  return Math.floor((pesewas * basisPoints + 5000) / 10000);
}

/** A percentage typed or stored to two decimals (5.5, 17.5) as basis points. */
export const percentToBasisPoints = (percent: number) => Math.round(percent * 100);

/* ───────────────────────────── rates ───────────────────────────── */

/** One slice of monthly chargeable income, lowest first. `width` is null for the last, which has no top. */
export type Band = { width: number | null; rate: number };

/** The rates one run is worked out on, in the units the arithmetic uses. */
export type Rates = {
  employeeBp: number;
  employerBp: number;
  tier2Bp: number;
  /** Pesewas of basic salary above which nothing more is contributed. */
  maxInsurable: number;
  /** Widths in PESEWAS, rates in percent. */
  bands: Band[];
};

export const MAX_MONEY_CEDIS = 9_999_999.99;

/**
 * The bands as stored (cedis, untrusted JSON) read into pesewas, or why not. A band set that does not end in an
 * open-topped band would silently stop taxing at its last slice, so that is refused rather than assumed.
 */
export function readBands(raw: unknown): { ok: true; bands: Band[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 12) {
    return { ok: false, error: "The tax bands must be a list of between 1 and 12 bands." };
  }
  const bands: Band[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i] as { width?: unknown; rate?: unknown } | null;
    const last = i === raw.length - 1;
    const rate = typeof item?.rate === "number" ? item.rate : NaN;
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || Math.abs(rate * 100 - Math.round(rate * 100)) > 1e-9) {
      return { ok: false, error: `Band ${i + 1} needs a rate between 0 and 100 with at most two decimals.` };
    }
    if (last) {
      if (item?.width !== null && item?.width !== undefined) {
        return { ok: false, error: "The last band has no top. Write it as \"rest\" so everything above is taxed." };
      }
      bands.push({ width: null, rate });
      continue;
    }
    const width = typeof item?.width === "number" ? item.width : NaN;
    if (!Number.isFinite(width) || width <= 0 || width > MAX_MONEY_CEDIS || Math.abs(width * 100 - Math.round(width * 100)) > 1e-9) {
      return { ok: false, error: `Band ${i + 1} needs an amount above 0 with at most two decimals.` };
    }
    bands.push({ width: Math.round(width * 100), rate });
  }
  return { ok: true, bands };
}

/** Bands back to the form a head types: one per line, "amount, rate", the last "rest, rate". */
export function bandsToText(bands: ReadonlyArray<{ width: number | null; rate: number }>, inCedis = true): string {
  return bands
    .map((b) => `${b.width === null ? "rest" : inCedis ? b.width : fromPesewas(b.width)}, ${b.rate}`)
    .join("\n");
}

/** The form's textarea to the shape stored (cedis). The same checks as `readBands`, with the line named in the message. */
export function parseBandsText(text: string): { ok: true; json: { width: number | null; rate: number }[] } | { ok: false; error: string } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: false, error: "Enter the tax bands, one per line." };
  const json: { width: number | null; rate: number }[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const parts = lines[i]!.split(/[,\s]+/).filter(Boolean);
    if (parts.length !== 2) return { ok: false, error: `Line ${i + 1}: write the band as "amount, rate", for example "588, 0".` };
    const [amountText, rateText] = parts as [string, string];
    const rate = /^\d+(\.\d{1,2})?$/.test(rateText) ? Number(rateText) : NaN;
    if (!Number.isFinite(rate)) return { ok: false, error: `Line ${i + 1}: the rate "${rateText}" is not a percentage.` };
    if (amountText.toLowerCase() === "rest") {
      json.push({ width: null, rate });
    } else {
      const amount = /^\d+(\.\d{1,2})?$/.test(amountText.replace(/,/g, "")) ? Number(amountText.replace(/,/g, "")) : NaN;
      if (!Number.isFinite(amount)) return { ok: false, error: `Line ${i + 1}: the amount "${amountText}" is not a sum of money.` };
      json.push({ width: amount, rate });
    }
  }
  const checked = readBands(json);
  if (!checked.ok) return checked;
  return { ok: true, json };
}

/** The tax on one month's chargeable income, in pesewas, worked slice by slice and rounded once at the end. */
export function taxOn(chargeable: number, bands: ReadonlyArray<Band>): number {
  let remaining = Math.max(0, chargeable);
  let units = 0; // pesewas x basis points; one rounding for the whole sum
  for (const band of bands) {
    if (remaining <= 0) break;
    const slice = band.width === null ? remaining : Math.min(remaining, band.width);
    units += slice * percentToBasisPoints(band.rate);
    remaining -= slice;
  }
  return Math.floor((units + 5000) / 10000);
}

/** The rate set that applies to a month: the latest one that took effect on or before its first day. */
export function rateSetFor<T extends { effectiveFrom: Date }>(sets: ReadonlyArray<T>, year: number, month: number): T | null {
  const start = Date.UTC(year, month - 1, 1);
  let best: T | null = null;
  for (const set of sets) {
    if (set.effectiveFrom.getTime() <= start && (!best || set.effectiveFrom.getTime() > best.effectiveFrom.getTime())) {
      best = set;
    }
  }
  return best;
}

/**
 * The starting rate set a school is given, as a STARTING POINT in the way fee items are: GRA's monthly table for
 * resident individuals from 1 September 2026 and the SSNIT rates and 2026 ceiling as published. It arrives
 * unconfirmed, and a run cannot be approved on it until a person has checked it against GRA and SSNIT.
 *
 * Tier 2's 5% is the part of the 18.5% total that goes to the trustee. The published sources disagree on how
 * Tier 2 is split between employee and employer and on whether the ceiling caps it, so the split here is used
 * only to divide the remittance, and the figure is for the accountant to confirm.
 */
export const STARTING_RATES = {
  label: "GRA monthly rates from 1 September 2026",
  effectiveFrom: "2026-09-01",
  ssnitEmployeePercent: 5.5,
  ssnitEmployerPercent: 13,
  ssnitTier2Percent: 5,
  ssnitMaxInsurable: 69000,
  taxBands: [
    { width: 588, rate: 0 },
    { width: 80, rate: 5 },
    { width: 100, rate: 10 },
    { width: 2900, rate: 17.5 },
    { width: 16000, rate: 25 },
    { width: 30332, rate: 30 },
    { width: null, rate: 35 },
  ] as { width: number | null; rate: number }[],
};

/* ───────────────────────────── one payslip ───────────────────────────── */

export type PayItemInput = {
  id: string;
  kind: "ALLOWANCE" | "DEDUCTION";
  name: string;
  amount: number;
  taxable: boolean;
  /** A deduction's whole sum owed, or null if it runs until switched off. */
  principal: number | null;
  /** Already taken by earlier APPROVED runs. */
  taken: number;
};

export type PayslipInput = {
  basic: number;
  ssnitApplies: boolean;
  items: ReadonlyArray<PayItemInput>;
};

export type PayslipLineOut = { payItemId: string; kind: "ALLOWANCE" | "DEDUCTION"; name: string; amount: number; taxable: boolean };

export type PayslipOut = {
  basic: number;
  allowances: number;
  gross: number;
  ssnitBase: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  ssnitTier2: number;
  taxableIncome: number;
  chargeable: number;
  paye: number;
  deductions: number;
  net: number;
  lines: PayslipLineOut[];
  warnings: string[];
};

/** What a deduction still has to take: null when it has no end, otherwise the principal less what was taken. */
export function stillOwed(item: Pick<PayItemInput, "principal" | "taken">): number | null {
  return item.principal === null ? null : Math.max(0, item.principal - item.taken);
}

/**
 * One person's month. The order is the law of the land and is not negotiable:
 *
 *   1. SSNIT on BASIC salary only (capped at the insurable ceiling), 5.5% from the employee.
 *   2. Taxable pay is basic plus the allowances marked taxable; the employee's SSNIT comes off it BEFORE tax.
 *   3. PAYE on what is left, band by band.
 *   4. Deductions come off what is left AFTER tax, last, and never take pay below zero: a deduction the pay does
 *      not cover is cut short and says so, and what is still owed stays on the loan for next month.
 *
 * A deduction with a principal stops when that sum has been taken, and its last instalment is only what remains.
 */
export function computePayslip(input: PayslipInput, rates: Rates): PayslipOut {
  const warnings: string[] = [];
  const allowanceItems = input.items.filter((i) => i.kind === "ALLOWANCE");
  const deductionItems = input.items.filter((i) => i.kind === "DEDUCTION");

  const allowances = allowanceItems.reduce((sum, i) => sum + i.amount, 0);
  const taxableAllowances = allowanceItems.filter((i) => i.taxable).reduce((sum, i) => sum + i.amount, 0);
  const gross = input.basic + allowances;

  const ssnitBase = input.ssnitApplies ? Math.min(input.basic, rates.maxInsurable) : 0;
  const ssnitEmployee = ofBasisPoints(ssnitBase, rates.employeeBp);
  const ssnitEmployer = ofBasisPoints(ssnitBase, rates.employerBp);
  const ssnitTier2 = ofBasisPoints(ssnitBase, rates.tier2Bp);
  if (input.ssnitApplies && input.basic > rates.maxInsurable) {
    warnings.push(`Basic salary is above the SSNIT ceiling of GH¢${fromPesewas(rates.maxInsurable)}; contributions are worked on the ceiling.`);
  }

  const taxableIncome = input.basic + taxableAllowances;
  const chargeable = Math.max(0, taxableIncome - ssnitEmployee);
  const paye = taxOn(chargeable, rates.bands);

  const lines: PayslipLineOut[] = allowanceItems.map((i) => ({
    payItemId: i.id, kind: "ALLOWANCE", name: i.name, amount: i.amount, taxable: i.taxable,
  }));

  let available = gross - ssnitEmployee - paye;
  let deductions = 0;
  for (const item of deductionItems) {
    const owed = stillOwed(item);
    const want = owed === null ? item.amount : Math.min(item.amount, owed);
    if (want <= 0) continue;
    const take = Math.max(0, Math.min(want, available));
    if (take < want) {
      warnings.push(
        take === 0
          ? `${item.name}: nothing could be taken, pay after tax does not cover it (GH¢${fromPesewas(want)} due).`
          : `${item.name}: only GH¢${fromPesewas(take)} of GH¢${fromPesewas(want)} could be taken, pay after tax ran out.`,
      );
    }
    if (take > 0) {
      lines.push({ payItemId: item.id, kind: "DEDUCTION", name: item.name, amount: take, taxable: false });
      available -= take;
      deductions += take;
    }
  }

  return {
    basic: input.basic,
    allowances,
    gross,
    ssnitBase,
    ssnitEmployee,
    ssnitEmployer,
    ssnitTier2,
    taxableIncome,
    chargeable,
    paye,
    deductions,
    net: gross - ssnitEmployee - paye - deductions,
    lines,
    warnings,
  };
}

/* ───────────────────────────── a run ───────────────────────────── */

export type RunStatus = "DRAFT" | "APPROVED" | "PAID";

/**
 * Every move a run can make. A DRAFT is approved (and posted); an APPROVED run is paid, or REOPENED to DRAFT with its
 * posting reversed. A PAID run is final: money has left, and the only correction is a new entry by the accountant.
 */
const MOVES: Record<RunStatus, RunStatus[]> = {
  DRAFT: ["APPROVED"],
  APPROVED: ["PAID", "DRAFT"],
  PAID: [],
};

export const RUN_STATUSES: RunStatus[] = ["DRAFT", "APPROVED", "PAID"];
export const canMoveRun = (from: RunStatus, to: RunStatus) => MOVES[from].includes(to);

export type RunTotals = {
  people: number;
  basic: number;
  allowances: number;
  gross: number;
  ssnitEmployee: number;
  ssnitEmployer: number;
  ssnitTier2: number;
  paye: number;
  deductions: number;
  net: number;
};

export function sumRun(
  slips: ReadonlyArray<Pick<PayslipOut, "basic" | "allowances" | "gross" | "ssnitEmployee" | "ssnitEmployer" | "ssnitTier2" | "paye" | "deductions" | "net">>,
): RunTotals {
  const t: RunTotals = { people: slips.length, basic: 0, allowances: 0, gross: 0, ssnitEmployee: 0, ssnitEmployer: 0, ssnitTier2: 0, paye: 0, deductions: 0, net: 0 };
  for (const s of slips) {
    t.basic += s.basic; t.allowances += s.allowances; t.gross += s.gross;
    t.ssnitEmployee += s.ssnitEmployee; t.ssnitEmployer += s.ssnitEmployer; t.ssnitTier2 += s.ssnitTier2;
    t.paye += s.paye; t.deductions += s.deductions; t.net += s.net;
  }
  return t;
}

/** What goes to SSNIT (Tier 1) and to the trustee (Tier 2) out of everything remitted for a month. */
export function remittanceSplit(totals: Pick<RunTotals, "ssnitEmployee" | "ssnitEmployer" | "ssnitTier2">) {
  const total = totals.ssnitEmployee + totals.ssnitEmployer;
  return { total, tier2: totals.ssnitTier2, tier1: total - totals.ssnitTier2 };
}

/* ───────────────────────────── the ledger ───────────────────────────── */

export type PayrollAccounts = {
  salary: string | null;
  paye: string | null;
  ssnit: string | null;
  netPay: string | null;
  advances: string | null;
};

export type PostingLine = { accountId: string; debit?: number; credit?: number; description: string };

/**
 * The entry an approved run posts, in pesewas, or the names of the accounts that stop it. Salaries cost the school
 * the gross AND the employer's SSNIT; what is owed out of that is PAYE, SSNIT (both shares), advances recovered
 * from staff and net pay. A line with nothing in it is left out (a journal line is a debit XOR a credit), and only
 * the accounts a run actually needs are asked for: a school with no advances this month does not need that account.
 */
export function payrollEntry(
  totals: Pick<RunTotals, "gross" | "ssnitEmployee" | "ssnitEmployer" | "paye" | "deductions" | "net">,
  accounts: PayrollAccounts,
): { ok: true; lines: PostingLine[] } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const need = (id: string | null, label: string, amount: number) => {
    if (amount > 0 && !id) missing.push(label);
  };
  const ssnit = totals.ssnitEmployee + totals.ssnitEmployer;
  need(accounts.salary, "Salaries expense", totals.gross + totals.ssnitEmployer);
  need(accounts.paye, "PAYE payable", totals.paye);
  need(accounts.ssnit, "SSNIT payable", ssnit);
  need(accounts.advances, "Staff advances", totals.deductions);
  need(accounts.netPay, "Net pay payable", totals.net);
  if (missing.length > 0) return { ok: false, missing };

  const lines: PostingLine[] = [];
  const add = (id: string | null, side: "debit" | "credit", amount: number, description: string) => {
    if (id && amount > 0) lines.push({ accountId: id, [side]: amount, description });
  };
  add(accounts.salary, "debit", totals.gross + totals.ssnitEmployer, "Salaries and employer SSNIT");
  add(accounts.paye, "credit", totals.paye, "PAYE withheld");
  add(accounts.ssnit, "credit", ssnit, "SSNIT, employee and employer shares");
  add(accounts.advances, "credit", totals.deductions, "Deductions recovered from staff");
  add(accounts.netPay, "credit", totals.net, "Net pay owed to staff");
  return { ok: true, lines };
}

/* ───────────────────────────── periods ───────────────────────────── */

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export const periodLabel = (year: number, month: number) => `${MONTH_NAMES[month - 1] ?? "?"} ${year}`;
export const periodKey = (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}`;

/** "2026-11" to year and month. A month that has not started is refused: nobody is paid in advance by accident. */
export function readPeriod(text: string, today: Date): { ok: true; year: number; month: number } | { ok: false; error: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(text.trim());
  if (!m) return { ok: false, error: "Choose the month to pay." };
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return { ok: false, error: "That month is not a real one." };
  if (year * 12 + month > today.getUTCFullYear() * 12 + today.getUTCMonth() + 1) {
    return { ok: false, error: `${periodLabel(year, month)} has not started yet.` };
  }
  return { ok: true, year, month };
}

/* ───────────────────────────── reading what is typed ───────────────────────────── */

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** An amount in cedis, 0.01 up to the field's top, with at most two decimals. A comma is a thousands separator. */
export function readAmount(text: string, label: string, opts: { min?: number; max?: number } = {}): { ok: true; cedis: number } | { ok: false; error: string } {
  const clean = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return { ok: false, error: `${label} must be an amount in cedis, like 1500 or 1500.50.` };
  const cedis = Number(clean);
  const min = opts.min ?? 0.01;
  const max = opts.max ?? MAX_MONEY_CEDIS;
  if (cedis < min) return { ok: false, error: `${label} must be at least GH¢${min.toFixed(2)}.` };
  if (cedis > max) return { ok: false, error: `${label} cannot be more than GH¢${max.toLocaleString("en-GH")}.` };
  return { ok: true, cedis };
}

export function readName(text: string, label: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = text.trim().replace(/\s+/g, " ");
  if (!name) return { ok: false, error: `${label} is needed.` };
  if (name.length > 60) return { ok: false, error: `${label} is too long (60 characters at most).` };
  if (CONTROL.test(name)) return { ok: false, error: `${label} has a character that cannot be printed.` };
  return { ok: true, name };
}

export type PayItemValue = {
  kind: "ALLOWANCE" | "DEDUCTION";
  name: string;
  amount: number;
  taxable: boolean;
  principal: number | null;
};

/** A new allowance or deduction. A deduction's "total owed" is optional; an allowance has none and is taxable unless said not. */
export function readPayItem(raw: Record<string, string>): { ok: true; value: PayItemValue } | { ok: false; error: string } {
  const kind = raw.kind === "DEDUCTION" ? "DEDUCTION" : raw.kind === "ALLOWANCE" ? "ALLOWANCE" : null;
  if (!kind) return { ok: false, error: "Choose whether this is an allowance or a deduction." };
  const name = readName(raw.name ?? "", "The name");
  if (!name.ok) return name;
  const amount = readAmount(raw.amount ?? "", kind === "ALLOWANCE" ? "The monthly amount" : "The amount taken each month");
  if (!amount.ok) return amount;
  let principal: number | null = null;
  if (kind === "DEDUCTION" && (raw.principal ?? "").trim() !== "") {
    const total = readAmount(raw.principal ?? "", "The total owed");
    if (!total.ok) return total;
    if (total.cedis < amount.cedis) return { ok: false, error: "The total owed cannot be less than one month's instalment." };
    principal = total.cedis;
  }
  return {
    ok: true,
    value: { kind, name: name.name, amount: amount.cedis, taxable: kind === "ALLOWANCE" ? raw.taxable !== "no" : false, principal },
  };
}

export type RateSetValue = {
  label: string;
  effectiveFrom: string;
  ssnitEmployeePercent: number;
  ssnitEmployerPercent: number;
  ssnitTier2Percent: number;
  ssnitMaxInsurable: number;
  taxBands: { width: number | null; rate: number }[];
};

const percentField = (text: string, label: string) => {
  const clean = text.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(clean) || Number(clean) > 100) return { ok: false as const, error: `${label} must be a percentage between 0 and 100.` };
  return { ok: true as const, value: Number(clean) };
};

export function readRateSet(raw: Record<string, string>): { ok: true; value: RateSetValue } | { ok: false; error: string } {
  const label = readName(raw.label ?? "", "The label");
  if (!label.ok) return label;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec((raw.effectiveFrom ?? "").trim());
  if (!date || new Date(`${date[0]}T00:00:00Z`).toISOString().slice(0, 10) !== date[0]) {
    return { ok: false, error: "Choose the date these rates start from." };
  }
  const employee = percentField(raw.ssnitEmployeePercent ?? "", "The employee's SSNIT rate");
  if (!employee.ok) return employee;
  const employer = percentField(raw.ssnitEmployerPercent ?? "", "The employer's SSNIT rate");
  if (!employer.ok) return employer;
  const tier2 = percentField(raw.ssnitTier2Percent ?? "", "The Tier 2 share");
  if (!tier2.ok) return tier2;
  if (tier2.value > employee.value + employer.value) return { ok: false, error: "The Tier 2 share cannot be more than the employee and employer rates together." };
  const max = readAmount(raw.ssnitMaxInsurable ?? "", "The SSNIT ceiling");
  if (!max.ok) return max;
  const bands = parseBandsText(raw.taxBands ?? "");
  if (!bands.ok) return bands;
  return {
    ok: true,
    value: {
      label: label.name,
      effectiveFrom: date[0],
      ssnitEmployeePercent: employee.value,
      ssnitEmployerPercent: employer.value,
      ssnitTier2Percent: tier2.value,
      ssnitMaxInsurable: max.cedis,
      taxBands: bands.json,
    },
  };
}

/** A rate set in the units the arithmetic uses, from what the database holds. */
export function ratesFrom(row: {
  ssnitEmployeePercent: { toString(): string };
  ssnitEmployerPercent: { toString(): string };
  ssnitTier2Percent: { toString(): string };
  ssnitMaxInsurable: { toString(): string };
  taxBands: unknown;
}): { ok: true; rates: Rates } | { ok: false; error: string } {
  const bands = readBands(row.taxBands);
  if (!bands.ok) return bands;
  return {
    ok: true,
    rates: {
      employeeBp: percentToBasisPoints(Number(row.ssnitEmployeePercent.toString())),
      employerBp: percentToBasisPoints(Number(row.ssnitEmployerPercent.toString())),
      tier2Bp: percentToBasisPoints(Number(row.ssnitTier2Percent.toString())),
      maxInsurable: toPesewas(row.ssnitMaxInsurable),
      bands: bands.bands,
    },
  };
}
