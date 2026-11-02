/**
 * Payroll: the arithmetic, the rules, and the shape of the code around them.
 *
 *   npm run verify:payroll
 *
 * No database and no server. Every expected figure below was worked out BY HAND from the GRA table and the SSNIT
 * rates and written in as a constant. None is computed with the code under test, because a check that derives its
 * answer from the function it is checking proves only that the function agrees with itself.
 *
 * The shape checks read the source with comments stripped (this codebase explains its mistakes at length, and a
 * comment naming a rule would satisfy a check that the rule is not there). `verify:payroll-route` drives the real
 * screens and the engine against the database.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  STARTING_RATES,
  bandsToText,
  canMoveRun,
  computePayslip,
  fromPesewas,
  ofBasisPoints,
  parseBandsText,
  payrollEntry,
  periodLabel,
  rateSetFor,
  ratesFrom,
  readAmount,
  readBands,
  readPayItem,
  readPeriod,
  readRateSet,
  remittanceSplit,
  stillOwed,
  sumRun,
  taxOn,
  toPesewas,
  type PayItemInput,
  type Rates,
  type RunStatus,
} from "@/lib/payroll-rules";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

const root = resolve(import.meta.dirname, "..");
const code = (file: string) =>
  readFileSync(resolve(root, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/* ───────────────────────────── the starting rates ───────────────────────────── */

console.log("The starting rates");
const read = ratesFrom({
  ssnitEmployeePercent: STARTING_RATES.ssnitEmployeePercent,
  ssnitEmployerPercent: STARTING_RATES.ssnitEmployerPercent,
  ssnitTier2Percent: STARTING_RATES.ssnitTier2Percent,
  ssnitMaxInsurable: STARTING_RATES.ssnitMaxInsurable,
  taxBands: STARTING_RATES.taxBands,
});
if (!read.ok) throw new Error(`the starting rates cannot be read: ${read.error}`);
const rates: Rates = read.rates;

check("the bands add up to GH¢50,000 before the open top band, as the GRA table does", rates.bands.slice(0, -1).reduce((s, b) => s + (b.width ?? 0), 0) === 5_000_000);
check("seven bands, the first untaxed at GH¢588 and the last 35%", rates.bands.length === 7 && rates.bands[0]!.width === 58_800 && rates.bands[0]!.rate === 0 && rates.bands[6]!.rate === 35 && rates.bands[6]!.width === null);
check("SSNIT is 5.5% from the employee and 13% from the employer, with a GH¢69,000 ceiling", rates.employeeBp === 550 && rates.employerBp === 1300 && rates.maxInsurable === 6_900_000);

/* ───────────────────────────── PAYE ───────────────────────────── */

console.log("\nPAYE, band by band (each figure worked by hand)");
const tax = (cedis: number) => taxOn(Math.round(cedis * 100), rates.bands);
check("nothing is taxed up to GH¢588", tax(0) === 0 && tax(588) === 0 && tax(300) === 0);
check("GH¢668 owes 5% of the GH¢80 above 588: GH¢4.00", tax(668) === 400, String(tax(668)));
check("GH¢768 owes GH¢14.00", tax(768) === 1_400, String(tax(768)));
check("GH¢3,668 owes GH¢14 + 17.5% of 2,900 = GH¢521.50", tax(3_668) === 52_150, String(tax(3_668)));
check("GH¢19,668 owes GH¢521.50 + 25% of 16,000 = GH¢4,521.50", tax(19_668) === 452_150, String(tax(19_668)));
check("GH¢50,000 owes GH¢4,521.50 + 30% of 30,332 = GH¢13,621.10", tax(50_000) === 1_362_110, String(tax(50_000)));
check("GH¢60,000 owes GH¢13,621.10 + 35% of 10,000 = GH¢17,121.10", tax(60_000) === 1_712_110, String(tax(60_000)));
check("GH¢3,335 owes 449.225 + 14 = 463.225, and half is rounded UP to GH¢463.23", tax(3_335) === 46_323, String(tax(3_335)));
check("a negative figure owes nothing, rather than a refund", taxOn(-5_000, rates.bands) === 0);
check("rounding is half up in whole pesewas: 0.5 of a pesewa is a pesewa", ofBasisPoints(1, 5_000) === 1 && ofBasisPoints(333, 550) === 18);

/* ───────────────────────────── a payslip ───────────────────────────── */

console.log("\nA payslip (hand-worked)");
const item = (over: Partial<PayItemInput> & Pick<PayItemInput, "id" | "kind" | "name" | "amount">): PayItemInput => ({
  taxable: true, principal: null, taken: 0, ...over,
});

const w1 = computePayslip(
  {
    basic: 300_000,
    ssnitApplies: true,
    items: [
      item({ id: "a1", kind: "ALLOWANCE", name: "Transport", amount: 20_000, taxable: false }),
      item({ id: "a2", kind: "ALLOWANCE", name: "Responsibility", amount: 50_000 }),
      item({ id: "d1", kind: "DEDUCTION", name: "Advance", amount: 30_000, principal: 100_000, taken: 80_000 }),
    ],
  },
  rates,
);
check("gross is basic plus every allowance: GH¢3,700", w1.gross === 370_000);
check("SSNIT is worked on BASIC only: employee GH¢165, employer GH¢390, Tier 2 GH¢150", w1.ssnitEmployee === 16_500 && w1.ssnitEmployer === 39_000 && w1.ssnitTier2 === 15_000, JSON.stringify(w1));
check("taxable pay leaves out the allowance marked not taxed: GH¢3,500", w1.taxableIncome === 350_000);
check("the employee's SSNIT comes off BEFORE tax: chargeable GH¢3,335", w1.chargeable === 333_500);
check("PAYE is GH¢463.23", w1.paye === 46_323);
check("the loan has GH¢200 left, so only GH¢200 is taken though the instalment is GH¢300", w1.deductions === 20_000 && w1.lines.find((l) => l.kind === "DEDUCTION")?.amount === 20_000);
check("net pay is GH¢2,871.77", w1.net === 287_177, String(w1.net));
check("gross less SSNIT, PAYE and deductions IS net", w1.gross - w1.ssnitEmployee - w1.paye - w1.deductions === w1.net);
check("no warning on an ordinary month", w1.warnings.length === 0);

const w2 = computePayslip({ basic: 8_000_000, ssnitApplies: true, items: [] }, rates);
check("above the ceiling, contributions stop at GH¢69,000: employee GH¢3,795, employer GH¢8,970", w2.ssnitBase === 6_900_000 && w2.ssnitEmployee === 379_500 && w2.ssnitEmployer === 897_000);
check("and the payslip says so", w2.warnings.some((w) => w.includes("ceiling")));

const w3 = computePayslip({ basic: 300_000, ssnitApplies: false, items: [] }, rates);
check("someone not in SSNIT pays none either side, and tax is on the whole GH¢3,000: GH¢404.60", w3.ssnitEmployee === 0 && w3.ssnitEmployer === 0 && w3.paye === 40_460 && w3.net === 259_540, JSON.stringify(w3));

const w4 = computePayslip({ basic: 60_000, ssnitApplies: true, items: [item({ id: "d1", kind: "DEDUCTION", name: "Loan", amount: 80_000 })] }, rates);
check("a deduction pay cannot cover is cut short, never taking pay below zero", w4.deductions === 56_700 && w4.net === 0);
check("and says how much it took", w4.warnings.some((w) => w.includes("Loan") && w.includes("567.00")), w4.warnings.join("|"));

const w5 = computePayslip(
  { basic: 60_000, ssnitApplies: true, items: [item({ id: "d1", kind: "DEDUCTION", name: "First", amount: 50_000 }), item({ id: "d2", kind: "DEDUCTION", name: "Second", amount: 30_000 })] },
  rates,
);
check("two deductions come off in the order given, the second cut short", w5.lines[0]?.amount === 50_000 && w5.lines[1]?.amount === 6_700 && w5.net === 0);
check("only the second is warned about", w5.warnings.length === 1 && w5.warnings[0]!.includes("Second"));

const w6 = computePayslip({ basic: 300_000, ssnitApplies: true, items: [item({ id: "d1", kind: "DEDUCTION", name: "Done", amount: 30_000, principal: 100_000, taken: 100_000 })] }, rates);
check("a loan that has been repaid takes nothing and writes no line", w6.deductions === 0 && w6.lines.length === 0 && w6.warnings.length === 0);

const w7 = computePayslip({ basic: 300_000, ssnitApplies: true, items: [item({ id: "d1", kind: "DEDUCTION", name: "Union dues", amount: 5_000 })] }, rates);
check("a deduction with no total goes on taking its instalment", w7.deductions === 5_000);
check("what a loan still owes is its principal less what was taken, and never negative", stillOwed({ principal: 100_000, taken: 80_000 }) === 20_000 && stillOwed({ principal: 100, taken: 500 }) === 0 && stillOwed({ principal: null, taken: 7 }) === null);

const w8 = computePayslip({ basic: 300_000, ssnitApplies: true, items: [item({ id: "a1", kind: "ALLOWANCE", name: "Stipend", amount: 100_000, taxable: true })] }, rates);
const w9 = computePayslip({ basic: 300_000, ssnitApplies: true, items: [item({ id: "a1", kind: "ALLOWANCE", name: "Stipend", amount: 100_000, taxable: false })] }, rates);
check("a GH¢1,000 allowance that is taxed lifts chargeable pay to GH¢3,835 and PAYE to GH¢563.25 (521.50 + 25% of 167)", w8.chargeable === 383_500 && w8.paye === 56_325, `${w8.chargeable} ${w8.paye}`);
check("the same allowance not taxed leaves chargeable pay at GH¢2,835 and PAYE at GH¢375.73", w9.chargeable === 283_500 && w9.paye === 37_573, `${w9.chargeable} ${w9.paye}`);

/* ───────────────────────────── a run ───────────────────────────── */

console.log("\nA run and the accounts");
const totals = sumRun([w1]);
check("a run's totals are the sum of its payslips", totals.gross === 370_000 && totals.net === 287_177 && totals.people === 1);
const accounts = { salary: "S", paye: "P", ssnit: "N", netPay: "T", advances: "A" };
const entry = payrollEntry(totals, accounts);
if (!entry.ok) throw new Error("the worked example did not post");
const debit = entry.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
const credit = entry.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
check("salaries cost gross PLUS the employer's SSNIT: GH¢4,090 debited", debit === 409_000, String(debit));
check("PAYE, both SSNIT shares, advances and net pay are credited, and the entry balances", credit === 409_000 && entry.lines.length === 5, `${credit}`);
check("each credit is the right figure", entry.lines.find((l) => l.accountId === "P")?.credit === 46_323 && entry.lines.find((l) => l.accountId === "N")?.credit === 55_500 && entry.lines.find((l) => l.accountId === "A")?.credit === 20_000 && entry.lines.find((l) => l.accountId === "T")?.credit === 287_177);
const noAdvances = payrollEntry({ ...totals, deductions: 0, net: totals.net + 20_000 }, { ...accounts, advances: null });
check("a month with no advances does not need the advances account, and leaves no zero line", noAdvances.ok && noAdvances.lines.every((l) => (l.debit ?? 0) + (l.credit ?? 0) > 0) && noAdvances.lines.length === 4);
const unmapped = payrollEntry(totals, { ...accounts, paye: null, netPay: null });
check("an unmapped account that is needed stops the posting and is NAMED", !unmapped.ok && unmapped.missing.join() === "PAYE payable,Net pay payable");
check("the remittance splits into Tier 1 and Tier 2 without losing a pesewa", (() => { const s = remittanceSplit(totals); return s.total === 55_500 && s.tier2 === 15_000 && s.tier1 === 40_500; })());

const allMoves: [RunStatus, RunStatus, boolean][] = [
  ["DRAFT", "APPROVED", true], ["DRAFT", "PAID", false], ["DRAFT", "DRAFT", false],
  ["APPROVED", "PAID", true], ["APPROVED", "DRAFT", true], ["APPROVED", "APPROVED", false],
  ["PAID", "DRAFT", false], ["PAID", "APPROVED", false], ["PAID", "PAID", false],
];
check("all nine moves of a run are as intended: a paid run goes nowhere", allMoves.every(([from, to, ok]) => canMoveRun(from, to) === ok));

/* ───────────────────────────── months and rate sets ───────────────────────────── */

console.log("\nMonths and rate sets");
const sets = [{ id: "jan", effectiveFrom: new Date("2026-01-01T00:00:00Z") }, { id: "sep", effectiveFrom: new Date("2026-09-01T00:00:00Z") }];
check("August 2026 is worked on the rates in force then, September on the new ones", rateSetFor(sets, 2026, 8)?.id === "jan" && rateSetFor(sets, 2026, 9)?.id === "sep" && rateSetFor(sets, 2027, 1)?.id === "sep");
check("a month before any rates started has none, rather than the nearest", rateSetFor(sets, 2025, 12) === null);
const today = new Date("2026-11-02T10:00:00Z");
check("this month and earlier ones can be paid", (() => { const r = readPeriod("2026-11", today); return r.ok && r.year === 2026 && r.month === 11; })() && readPeriod("2026-01", today).ok);
check("next month cannot", !readPeriod("2026-12", today).ok && !readPeriod("2027-01", today).ok);
check("nonsense is refused", !readPeriod("2026-13", today).ok && !readPeriod("November", today).ok && !readPeriod("", today).ok);
check("a month reads as words", periodLabel(2026, 11) === "November 2026");

/* ───────────────────────────── reading what is typed ───────────────────────────── */

console.log("\nWhat is typed");
const amount = (text: string) => readAmount(text, "Amount");
check("amounts: commas are thousands, two decimals at most", (() => { const r = amount("1,250.50"); return r.ok && r.cedis === 1250.5; })());
check("amounts: three decimals, a sign, text, nothing and zero are refused", ["1.234", "-5", "+5", "abc", "", "0", "0.00", "1e3"].every((t) => !amount(t).ok));
check("amounts: more than the field holds is refused", !amount("10000000").ok && amount("9999999.99").ok);
check("money round trips through pesewas without drift", toPesewas(fromPesewas(123_456) as unknown as number) === 123_456 && fromPesewas(5) === "0.05" && fromPesewas(100) === "1.00" && toPesewas(0.1 + 0.2) === 30);

const deduction = { kind: "DEDUCTION", name: "Advance", amount: "300", principal: "1000" };
check("a deduction may name a total, an allowance never keeps one", (() => { const d = readPayItem(deduction); const a = readPayItem({ kind: "ALLOWANCE", name: "Transport", amount: "200", principal: "999" }); return d.ok && d.value.principal === 1000 && a.ok && a.value.principal === null && a.value.taxable; })());
check("an allowance can be marked not taxable", (() => { const a = readPayItem({ kind: "ALLOWANCE", name: "Rent", amount: "200", taxable: "no" }); return a.ok && !a.value.taxable; })());
check("a total smaller than one instalment is refused", !readPayItem({ ...deduction, principal: "200" }).ok);
check("no kind, no name, a control character and a long name are refused", !readPayItem({ ...deduction, kind: "" }).ok && !readPayItem({ ...deduction, name: "  " }).ok && !readPayItem({ ...deduction, name: "Bad\u0007name" }).ok && !readPayItem({ ...deduction, name: "x".repeat(61) }).ok);

const goodSet = {
  label: "From 1 January 2027", effectiveFrom: "2027-01-01", ssnitEmployeePercent: "5.5", ssnitEmployerPercent: "13",
  ssnitTier2Percent: "5", ssnitMaxInsurable: "69,000", taxBands: "588, 0\n80, 5\nrest, 35",
};
check("a rate set reads", readRateSet(goodSet).ok);
check("a date that is not a date, a Tier 2 above the total, and a percentage over 100 are refused", !readRateSet({ ...goodSet, effectiveFrom: "2027-02-30" }).ok && !readRateSet({ ...goodSet, ssnitTier2Percent: "20" }).ok && !readRateSet({ ...goodSet, ssnitEmployeePercent: "101" }).ok);
check("bands: the last must be open, and none may be empty or beyond 100%", !parseBandsText("588, 0\n80, 5").ok && !parseBandsText("").ok && !parseBandsText("rest, 120").ok && !parseBandsText("588 0 1").ok && parseBandsText("588, 0\nrest, 35").ok);
check("a band set with the top in the middle is refused", !readBands([{ width: null, rate: 0 }, { width: null, rate: 5 }]).ok && !readBands([]).ok && !readBands("x").ok);
check("bands print and read back unchanged", (() => { const text = bandsToText(STARTING_RATES.taxBands); const back = parseBandsText(text); return back.ok && JSON.stringify(back.json) === JSON.stringify(STARTING_RATES.taxBands); })());

/* ───────────────────────────── the shape of the code ───────────────────────────── */

console.log("\nThe code around it");
const rules = code("src/lib/payroll-rules.ts");
const engine = code("src/lib/payroll-engine.ts");
const actions = code("src/lib/payroll-actions.ts");
const data = code("src/lib/payroll-data.ts");
const permissions = code("src/lib/permissions.ts");

check("the rules module is pure: no server-only, no database", !/server-only/.test(rules) && !/@\/lib\/prisma/.test(rules));
check("SSNIT is worked on basic salary only", /const ssnitBase = input\.ssnitApplies \? Math\.min\(input\.basic, rates\.maxInsurable\) : 0;/.test(rules));
check("tax is worked after SSNIT comes off, and before deductions", /const chargeable = Math\.max\(0, taxableIncome - ssnitEmployee\);/.test(rules) && rules.indexOf("const paye = taxOn(") < rules.indexOf("for (const item of deductionItems)"));
check("a deduction is capped at what pay is left", /Math\.min\(want, available\)/.test(rules));
check("no rate is written into the arithmetic: the only percentages in the rules module are the starting set", !/\b(?:0\.055|0\.13|0\.175|5\.5|17\.5|69000|69_000|588)\b/.test(rules.replace(/export const STARTING_RATES[\s\S]*?\n};/, "").replace(/`[^`]*`/g, "").replace(/"[^"\n]*"/g, "")));

check("approving needs the rates confirmed", /!picked\.set\.confirmedAt/.test(engine) && /have not been confirmed/.test(engine));
check("approving works the month out again and refuses a run that no longer agrees", /const fresh = await computeAll\(tx, actor\.schoolId, picked\.rates\)/.test(engine) && /if \(drifted\)/.test(engine));
check("approving refuses newer rates than the run was worked on", /picked\.set\.id !== run\.rateSetId/.test(engine));
check("the status moves by conditional update, so two heads cannot both approve", /updateMany\(\{ where: \{ id: runId, status: "DRAFT" \}/.test(engine) && /updateMany\(\{ where: \{ id: runId, status: "APPROVED" \}/.test(engine));
check("every step of a run takes the run's lock", (engine.match(/await lockOn\(tx, `payroll:\$\{runId\}`\)/g) ?? []).length === 5);
check("creating a run takes the school's lock and refuses a month that has one", /await lockOn\(tx, `payroll:\$\{actor\.schoolId\}`\)/.test(engine) && /already has a payroll run/.test(engine));
check("an approved run posts a journal, and an unposted one says so rather than failing", /sourceType: "PAYROLL"/.test(engine) && /It was NOT posted to the accounts/.test(engine));
check("reopening reverses what was posted, and a reversal is not mistaken for a live posting", /reverseJournalEntry\(/.test(engine) && /!entry\.memo\.startsWith\(REVERSAL\)/.test(engine));
check("a paid run cannot be reopened", /A paid run cannot be reopened/.test(engine));
check("payment is posted only where the approval was", /const live = await livePosting\(/.test(engine) && /sourceType: "PAYROLL_PAYMENT"/.test(engine));
check("what a loan owes is derived from approved runs, never stored", /run: \{ status: \{ in: \["APPROVED", "PAID"\] \} \}/.test(engine) && !/balance|owed:/.test(code("prisma/schema.prisma").split("model StaffPayItem")[1]!.split("\n}")[0]!));
check("the account mapping is read back through the tenant client", /ownsLedgerAccounts\(Object\.values\(clean\)\)/.test(engine));
check("a person is read back through the tenant client before their pay is written", (engine.match(/ownsStaff\(\[staffId\]\)/g) ?? []).length >= 2);
check("a rate set a run has used cannot be changed, and an edit takes back its confirmation", /A payroll run has already used these rates/.test(engine) && /confirmedAt: null/.test(engine));

// `${…}` holds a brace of its own and would end a block early, hiding whatever follows it.
const afterBlocks = [...engine.replace(/\$\{[^}]*\}/g, "X").matchAll(/after: \{([^}]*)\}/g)].map((m) => m[1]!);
check("no audit row carries a salary, an amount or a name", afterBlocks.length >= 10 && afterBlocks.every((b) => !/\b(?:basic|salary|gross|net|paye|ssnit(?!Applies)|amount|principal|name)\b/i.test(b)), afterBlocks.join(" | "));
check("the feed's phrases name a month, never a person or an amount", !/\ba\.(?:name|amount|basic|net|gross)\b/.test(code("src/lib/dashboard-data.ts").split('"payroll.setup"')[1]!.split('"application.delete"')[0]!));

const exported = actions.split("export async function ").slice(1);
check("every payroll action runs requireRole and sets the tenant context in its own frame", exported.length === 14 && exported.every((body) => /requireRole\(/.test(body) && /setTenantContext\(auth\.tenant\)/.test(body)), `${exported.length} actions`);
check("approve, reopen, mark paid and the rates are the head's", ["approveRunAction", "reopenRunAction", "markPaidAction", "saveRateSetAction", "confirmRateSetAction", "deleteRateSetAction"].every((name) => new RegExp(`${name}[\\s\\S]{0,160}requireRole\\(PAYROLL_APPROVE\\)`).test(actions)));
check("preparing a run and the pay records are finance's", ["createRunAction", "recalculateRunAction", "deleteRunAction", "saveStaffPayAction", "addPayItemAction", "setPayItemAction", "setUpPayrollAction", "saveAccountsAction"].every((name) => new RegExp(`${name}[\\s\\S]{0,160}requireRole\\(PAYROLL\\)`).test(actions)));

check("payroll is finance's to read and the head's to release", /export const PAYROLL: Role\[\] = FINANCE;/.test(permissions) && /export const PAYROLL_APPROVE: Role\[\] = LEADERSHIP;/.test(permissions));
check("the IT admin, the registrar and teachers are not in it", !/"IT_ADMIN"|"ADMIN"|"TEACHER"/.test(permissions.match(/export const PAYROLL: Role\[\][^;]*;/)![0]));
check("Payroll is on the rail for finance", /href: "\/payroll", label: "Payroll", icon: "payroll", roles: PAYROLL/.test(permissions));

const staffModel = code("prisma/schema.prisma").split("model Staff {")[1]!.split("\n}")[0]!;
check("a salary is not a column on Staff, so no staff query can carry it", !/basicSalary|salary/i.test(staffModel));

const walk = (dir: string): string[] =>
  readdirSync(resolve(root, dir)).flatMap((name) => {
    const full = join(dir, name);
    return statSync(resolve(root, full)).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
const leaks = walk("src").filter((f) => !/payroll/.test(f) && /basicSalary|\b(?:tx|prisma|db)\.staffPay(?:Item)?\b|\bpay: (?:true|\{)|payItems/.test(code(f)));
check("nothing outside payroll reads a salary", leaks.length === 0, leaks.join(", "));
check("the payroll screens read through the loaders, not the database", !/prisma\./.test(code("src/app/(app)/payroll/page.tsx")) && !/prisma\./.test(code("src/app/(app)/payroll/[runId]/page.tsx")));
check("the loaders hand money out as whole pesewas", /const pesewas = /.test(data));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
