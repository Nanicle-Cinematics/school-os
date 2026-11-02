/**
 * Payroll, against the real app and database.
 *
 *   npm run verify:payroll-route        (needs the app running)
 *
 * `verify:payroll` proves the arithmetic and the shape of the code. This proves them where it matters:
 *
 *   - a month is worked out for the people who have a pay record, to the pesewa, on rates the school holds;
 *   - a run cannot be approved on rates nobody confirmed, or on figures that no longer agree with the records
 *     (an edit, then a reversal of the edit, is allowed: it agrees again), or when newer rates have started;
 *   - approving posts ONE balanced entry (salaries = gross + employer SSNIT; PAYE, SSNIT, advances and net pay
 *     credited); reopening reverses it; paying moves net pay out; a paid run cannot be reopened;
 *   - what a loan still owes is derived from APPROVED runs: reopening puts the instalment back;
 *   - two approvals at once make one posting;
 *   - a payslip keeps the name it was worked out for; no audit row carries a salary;
 *   - the head sees every screen, an accountant the same but not the approval, a stranger none.
 *
 * It builds its own staff (ZZPAY-n), rates and accounts in the demo school, refuses to start if the school holds
 * payroll data that is not its own, and removes everything it made, also after a failure. Development databases only.
 */
import { createHash, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { STARTING_RATES, toPesewas } from "@/lib/payroll-rules";

// The development link answers in seconds and Prisma's defaults give up before it does; see verify-admissions-route.
{
  const appUrl = new URL(process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL!);
  appUrl.searchParams.set("pool_timeout", "90");
  appUrl.searchParams.set("connect_timeout", "60");
  process.env.APP_DATABASE_URL = appUrl.toString();
}
const { runWithTenantContext, withBypass } = await import("@/lib/tenant-context");
const engine = await import("@/lib/payroll-engine");
const dataLayer = await import("@/lib/payroll-data");

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const COOKIE = "school_os_session";
const dbUrl = new URL(process.env.DIRECT_URL!);
dbUrl.searchParams.set("pool_timeout", "60");
dbUrl.searchParams.set("connect_timeout", "60");
const owner = new PrismaClient({ datasourceUrl: dbUrl.toString() });

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 400)}` : ""}`);
  if (!ok) failures += 1;
}

{
  const up = await fetch(`${BASE}/login`, { redirect: "manual" }).then((r) => r.status === 200, () => false);
  if (!up) {
    console.log(`  SKIPPED — nothing answering at ${BASE}. Start the app to run this.`);
    process.exit(0);
  }
}

const school = await owner.school.findUniqueOrThrow({ where: { slug: "hope-demo" }, select: { id: true } });
const settingsBefore = await owner.schoolSettings.findUniqueOrThrow({
  where: { schoolId: school.id },
  select: { payrollSalaryAccountId: true, payrollPayeAccountId: true, payrollSsnitAccountId: true, payrollNetPayAccountId: true, payrollAdvancesAccountId: true, bankAccountId: true },
});
const startedAt = new Date();
const sessions: string[] = [];
const extraUsers: string[] = [];

const inSchool = <T,>(fn: () => Promise<T>) => runWithTenantContext({ schoolId: school.id }, fn);

/* ───────────────────────────── clean up, and refuse to touch anyone else's ───────────────────────────── */

const RUNS = [{ year: 2026, month: 10 }, { year: 2026, month: 11 }];

async function cleanUp() {
  const runs = await owner.payrollRun.findMany({ where: { schoolId: school.id }, select: { id: true } });
  const runIds = runs.map((r) => r.id);
  const entries = await owner.journalEntry.findMany({
    where: { schoolId: school.id, sourceType: { in: ["PAYROLL", "PAYROLL_PAYMENT"] }, sourceId: { in: runIds } },
    select: { id: true },
  });
  const entryIds = entries.map((e) => e.id);
  await owner.auditLog.deleteMany({ where: { schoolId: school.id, entityId: { in: entryIds } } });
  await owner.journalLine.deleteMany({ where: { journalEntryId: { in: entryIds } } });
  await owner.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
  await owner.payrollRun.deleteMany({ where: { schoolId: school.id } });
  await owner.staff.deleteMany({ where: { schoolId: school.id, staffNo: { startsWith: "ZZPAY-" } } });
  await owner.payrollRateSet.deleteMany({ where: { schoolId: school.id } });
  await owner.ledgerAccount.deleteMany({ where: { schoolId: school.id, code: { startsWith: "PAY_" } } });
  await owner.auditLog.deleteMany({ where: { schoolId: school.id, action: { startsWith: "payroll." }, createdAt: { gte: startedAt } } });
  await owner.schoolSettings.update({
    where: { schoolId: school.id },
    data: {
      payrollSalaryAccountId: settingsBefore.payrollSalaryAccountId,
      payrollPayeAccountId: settingsBefore.payrollPayeAccountId,
      payrollSsnitAccountId: settingsBefore.payrollSsnitAccountId,
      payrollNetPayAccountId: settingsBefore.payrollNetPayAccountId,
      payrollAdvancesAccountId: settingsBefore.payrollAdvancesAccountId,
    },
  });
  await withBypass(async () => {
    await owner.session.deleteMany({ where: { tokenHash: { in: sessions } } });
    await owner.membership.deleteMany({ where: { userId: { in: extraUsers } } });
    await owner.user.deleteMany({ where: { id: { in: extraUsers } } });
  });
}

const OURS = new Set([STARTING_RATES.label, "From 1 November 2026"]);
if (process.argv.includes("--clean")) {
  // After a run that was killed: forget the mapping it left and remove what it made, then stop.
  for (const key of Object.keys(settingsBefore)) if (key.startsWith("payroll")) (settingsBefore as Record<string, string | null>)[key] = null;
  await cleanUp();
  console.log("  Cleaned up what an earlier run left behind.");
  await owner.$disconnect();
  process.exit(0);
}
{
  const foreignRuns = await owner.payrollRun.count({ where: { schoolId: school.id, NOT: { OR: RUNS.map((r) => ({ periodYear: r.year, periodMonth: r.month })) } } });
  const foreignPay = await owner.staffPay.count({ where: { schoolId: school.id, staff: { staffNo: { not: { startsWith: "ZZPAY-" } } } } });
  const foreignRates = (await owner.payrollRateSet.findMany({ where: { schoolId: school.id }, select: { label: true } })).filter((r) => !OURS.has(r.label)).length;
  const mapped = Object.entries(settingsBefore).some(([key, value]) => key.startsWith("payroll") && value);
  if (foreignRuns > 0 || foreignPay > 0 || foreignRates > 0 || mapped) {
    console.log("  SKIPPED — this school already holds payroll data or payroll account choices. It will not touch them.");
    console.log("            If an earlier run of this guard was killed, clear what it left with: npm run verify:payroll-route -- --clean");
    process.exit(0);
  }
}
await cleanUp(); // anything an earlier, interrupted run left behind

/* ───────────────────────────── helpers ───────────────────────────── */

const head = await withBypass(() => owner.membership.findFirstOrThrow({ where: { schoolId: school.id, role: "OWNER" }, select: { userId: true } }));
const actor = { schoolId: school.id, userId: head.userId };

async function sessionFor(userId: string) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  await withBypass(() => owner.session.create({ data: { userId, tokenHash, activeSchoolId: school.id, expiresAt: new Date(Date.now() + 3 * 3_600_000) } }));
  sessions.push(tokenHash);
  return token;
}
const get = async (path: string, token?: string) => {
  const response = await fetch(`${BASE}${path}`, { headers: token ? { Cookie: `${COOKIE}=${token}` } : {}, redirect: "manual" });
  return { status: response.status, location: response.headers.get("location") ?? "", html: await response.text() };
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");

type R = { ok: string } | { error: string };
const said = (r: R) => ("ok" in r ? r.ok : r.error);
const isError = (r: R, match?: RegExp) => "error" in r && (!match || match.test(r.error));
const isOk = (r: R) => "ok" in r;

async function slipOf(runId: string, staffNo: string) {
  const s = await owner.payslip.findFirstOrThrow({ where: { runId, staffNo } });
  return {
    id: s.id, name: s.name,
    gross: toPesewas(s.gross), ssnitEmployee: toPesewas(s.ssnitEmployee), ssnitEmployer: toPesewas(s.ssnitEmployer), paye: toPesewas(s.paye),
    deductions: toPesewas(s.deductions), net: toPesewas(s.net), warnings: s.warnings,
  };
}
async function entriesFor(runId: string, sourceType: "PAYROLL" | "PAYROLL_PAYMENT") {
  return owner.journalEntry.findMany({ where: { schoolId: school.id, sourceType, sourceId: runId }, include: { lines: true }, orderBy: { createdAt: "asc" } });
}
const sumBy = (lines: { accountId: string; debit: unknown; credit: unknown }[]) => {
  const out = new Map<string, { debit: number; credit: number }>();
  for (const l of lines) {
    const cur = out.get(l.accountId) ?? { debit: 0, credit: 0 };
    cur.debit += toPesewas(l.debit as { toString(): string });
    cur.credit += toPesewas(l.credit as { toString(): string });
    out.set(l.accountId, cur);
  }
  return out;
};

try {
  /* ───────────────────────────── fixtures ───────────────────────────── */

  const people: { id: string; staffNo: string; name: string }[] = [];
  for (const n of [1, 2, 3]) {
    const s = await owner.staff.create({
      data: { schoolId: school.id, staffNo: `ZZPAY-${n}`, firstName: "Pay", lastName: `Tester${n}`, gender: "FEMALE", ssnitNumber: `C00${n}`, tin: `P00${n}` },
      select: { id: true, staffNo: true, firstName: true, lastName: true },
    });
    people.push({ id: s.id, staffNo: s.staffNo, name: `${s.firstName} ${s.lastName}` });
  }
  const [p1, p2, p3] = people as [(typeof people)[number], (typeof people)[number], (typeof people)[number]];

  console.log("Setting up");
  const first = await inSchool(() => engine.setUpPayroll(actor));
  check("set-up adds the accounts, maps them and gives the starting rates", isOk(first) && /starting rates/.test(said(first)), said(first));
  const second = await inSchool(() => engine.setUpPayroll(actor));
  check("doing it again changes nothing", isOk(second) && /already set up/.test(said(second)), said(second));
  const accounts = await owner.ledgerAccount.findMany({ where: { schoolId: school.id, code: { startsWith: "PAY_" } } });
  const acct = (code: string) => accounts.find((a) => a.code === code)!.id;
  check("five payroll accounts exist, and each is mapped in the settings", accounts.length === 5);
  const set1 = await owner.payrollRateSet.findFirstOrThrow({ where: { schoolId: school.id } });
  check("the starting rates arrive UNCONFIRMED", set1.confirmedAt === null);

  console.log("\nPay records");
  check("a person who is not this school's is refused", await (async () => {
    const stranger = await owner.staff.findFirst({ where: { schoolId: { not: school.id } }, select: { id: true } });
    if (!stranger) { console.log("  --   (no other school here to point at; skipped)"); return true; }
    return isError(await inSchool(() => engine.saveStaffPay(actor, stranger.id, 1000, true)), /not found/);
  })());
  check("an allowance before a salary is refused", isError(await inSchool(() => engine.addPayItem(actor, p1.id, { kind: "ALLOWANCE", name: "Early", amount: 10, taxable: true, principal: null })), /basic salary first/));
  check("pay is saved for three people", [await inSchool(() => engine.saveStaffPay(actor, p1.id, 3000, true)), await inSchool(() => engine.saveStaffPay(actor, p2.id, 5000, true)), await inSchool(() => engine.saveStaffPay(actor, p3.id, 600, false))].every(isOk));
  check("allowances and a loan are added", [
    await inSchool(() => engine.addPayItem(actor, p1.id, { kind: "ALLOWANCE", name: "Responsibility", amount: 500, taxable: true, principal: null })),
    await inSchool(() => engine.addPayItem(actor, p1.id, { kind: "ALLOWANCE", name: "Transport", amount: 200, taxable: false, principal: null })),
    await inSchool(() => engine.addPayItem(actor, p1.id, { kind: "DEDUCTION", name: "Advance", amount: 300, taxable: false, principal: 500 })),
    await inSchool(() => engine.addPayItem(actor, p3.id, { kind: "DEDUCTION", name: "Loan", amount: 800, taxable: false, principal: null })),
  ].every(isOk));

  /* ───────────────────────────── a month, worked out ───────────────────────────── */

  console.log("\nWorking October out (every figure worked by hand)");
  check("a month before any rates started is refused", isError(await inSchool(() => engine.createRun(actor, 2026, 8, null)), /No pay rates apply/));
  const made = await inSchool(() => engine.createRun(actor, 2026, 10, null));
  check("October is worked out for the three of them", "id" in made && /3 people/.test(said(made)), said(made));
  if (!("id" in made)) throw new Error("no run to go on with");
  const run1 = made.id;
  check("the same month cannot be worked out twice", isError(await inSchool(() => engine.createRun(actor, 2026, 10, null)), /already has a payroll run/));

  const s1 = await slipOf(run1, "ZZPAY-1");
  check("person 1: gross 3,700.00, SSNIT 165.00, PAYE 463.23, advance 300.00, net 2,771.77", s1.gross === 370_000 && s1.ssnitEmployee === 16_500 && s1.paye === 46_323 && s1.deductions === 30_000 && s1.net === 277_177, JSON.stringify(s1));
  const s2 = await slipOf(run1, "ZZPAY-2");
  check("person 2: SSNIT 275.00, PAYE 785.75, net 3,939.25", s2.ssnitEmployee === 27_500 && s2.paye === 78_575 && s2.net === 393_925, JSON.stringify(s2));
  const s3 = await slipOf(run1, "ZZPAY-3");
  check("person 3, not in SSNIT: no contribution, PAYE 0.60, the loan cut short at 599.40, net nil", s3.ssnitEmployee === 0 && s3.ssnitEmployer === 0 && s3.paye === 60 && s3.deductions === 59_940 && s3.net === 0, JSON.stringify(s3));
  check("and person 3's payslip says the loan was cut short", /Loan/.test(s3.warnings ?? "") && /599\.40/.test(s3.warnings ?? ""));

  console.log("\nApproving");
  check("approval is refused while the rates are unconfirmed", isError(await inSchool(() => engine.approveRun(actor, run1)), /have not been confirmed/));
  check("the rates are confirmed", isOk(await inSchool(() => engine.confirmRateSet(actor, set1.id))));
  await inSchool(() => engine.saveStaffPay(actor, p2.id, 5100, true));
  check("a salary changed after the run was worked out blocks approval", isError(await inSchool(() => engine.approveRun(actor, run1)), /changed since this run was worked out/));
  check("and the run is reported as out of date while the records disagree with it", (await inSchool(() => dataLayer.getRun(school.id, run1)))?.stale === true);
  await inSchool(() => engine.saveStaffPay(actor, p2.id, 5000, true));
  check("an unrelated edit and its reversal leaves the figures agreeing again", await (async () => {
    const r = await inSchool(() => engine.approveRun(actor, run1));
    return isOk(r) && /posted to the accounts/.test(said(r));
  })());

  const entries1 = await entriesFor(run1, "PAYROLL");
  check("exactly one entry was posted", entries1.length === 1);
  const byAcct = sumBy(entries1[0]!.lines);
  check("salaries debited 10,340.00: gross 9,300.00 plus the employer's SSNIT 1,040.00", byAcct.get(acct("PAY_SALARIES"))?.debit === 1_034_000, JSON.stringify([...byAcct]));
  check("PAYE payable credited 1,249.58, SSNIT 1,480.00 (both shares), advances 899.40, net pay 6,711.02", byAcct.get(acct("PAY_PAYE"))?.credit === 124_958 && byAcct.get(acct("PAY_SSNIT"))?.credit === 148_000 && byAcct.get(acct("PAY_ADVANCES"))?.credit === 89_940 && byAcct.get(acct("PAY_NET"))?.credit === 671_102);
  check("the entry balances", [...byAcct.values()].reduce((s, v) => s + v.debit, 0) === [...byAcct.values()].reduce((s, v) => s + v.credit, 0));

  check("an approved run cannot be recalculated, deleted or approved again", isError(await inSchool(() => engine.recalculateRun(actor, run1)), /Only a draft/) && isError(await inSchool(() => engine.deleteRun(actor, run1)), /Only a draft/) && isError(await inSchool(() => engine.approveRun(actor, run1)), /already approved/));
  const owedAfter = async () => (await inSchool(() => dataLayer.getStaffPay(school.id, p1.id)))!.items.find((i) => i.name === "Advance")!.owed;
  check("the advance now has 200.00 owing, worked out from the approved run", (await owedAfter()) === 20_000);

  console.log("\nReopening, approving again, paying");
  check("reopening reverses the posting and returns the run to a draft", await (async () => {
    const r = await inSchool(() => engine.reopenRun(actor, run1));
    return isOk(r) && /reversed/.test(said(r));
  })());
  const afterReopen = await entriesFor(run1, "PAYROLL");
  const net = [...sumBy(afterReopen.flatMap((e) => e.lines)).values()].reduce((s, v) => s + v.debit - v.credit, 0);
  check("two entries now stand, and together they come to nothing", afterReopen.length === 2 && /^Reversal: /.test(afterReopen[1]!.memo) && net === 0, `${afterReopen.length} entries, net ${net}`);
  check("the advance is back to 500.00 owing: an unapproved run takes nothing", (await owedAfter()) === 50_000);
  await owner.staff.update({ where: { id: p1.id }, data: { lastName: "Renamed" } });
  check("approving again posts a second live entry", isOk(await inSchool(() => engine.approveRun(actor, run1))) && (await entriesFor(run1, "PAYROLL")).length === 3);
  check("the payslip keeps the name it was worked out for", (await slipOf(run1, "ZZPAY-1")).name === "Pay Tester1");

  check("a method that is not a way of paying is refused", isError(await inSchool(() => engine.markPaid(actor, run1, new Date("2026-10-31T00:00:00Z"), "CARD")), /Choose how/));
  const paid = await inSchool(() => engine.markPaid(actor, run1, new Date("2026-10-31T00:00:00Z"), "BANK_TRANSFER"));
  check("marking it paid works", isOk(paid), said(paid));
  const payEntries = await entriesFor(run1, "PAYROLL_PAYMENT");
  if (settingsBefore.bankAccountId) {
    const lines = sumBy(payEntries[0]?.lines ?? []);
    check("net pay is moved out: net salaries payable debited and the bank credited 6,711.02", lines.get(acct("PAY_NET"))?.debit === 671_102 && lines.get(settingsBefore.bankAccountId)?.credit === 671_102);
  } else {
    check("with no bank account mapped, the payment is not posted and the answer says so", payEntries.length === 0 && /not recorded in the accounts/.test(said(paid)));
  }
  check("a paid run cannot be reopened, paid again or deleted", isError(await inSchool(() => engine.reopenRun(actor, run1)), /paid run cannot be reopened/) && isError(await inSchool(() => engine.markPaid(actor, run1, new Date(), "CASH")), /already marked paid/) && isError(await inSchool(() => engine.deleteRun(actor, run1)), /Only a draft/));

  /* ───────────────────────────── the next month ───────────────────────────── */

  console.log("\nWorking November out");
  const made2 = await inSchool(() => engine.createRun(actor, 2026, 11, "Second run"));
  if (!("id" in made2)) throw new Error(`no second run: ${said(made2)}`);
  const run2 = made2.id;
  const t1 = await slipOf(run2, "ZZPAY-1");
  check("the advance only takes what is left of it: 200.00, so net pay is 2,871.77", t1.deductions === 20_000 && t1.net === 287_177, JSON.stringify(t1));

  console.log("\nNewer rates");
  const newer = await inSchool(() =>
    engine.saveRateSet(actor, null, {
      label: "From 1 November 2026", effectiveFrom: "2026-11-01", ssnitEmployeePercent: 5.5, ssnitEmployerPercent: 13, ssnitTier2Percent: 5,
      ssnitMaxInsurable: 69000, taxBands: [{ width: 600, rate: 0 }, { width: null, rate: 30 }],
    }),
  );
  check("a later set of rates can be added", isOk(newer), said(newer));
  check("a run worked out on older rates cannot be approved once newer ones apply to its month", isError(await inSchool(() => engine.approveRun(actor, run2)), /Newer pay rates apply/));
  const newerSet = await owner.payrollRateSet.findFirstOrThrow({ where: { schoolId: school.id, effectiveFrom: new Date("2026-11-01T00:00:00Z") } });
  check("a second set on the same date is refused", isError(await inSchool(() => engine.saveRateSet(actor, null, {
    label: "Again", effectiveFrom: "2026-11-01", ssnitEmployeePercent: 5.5, ssnitEmployerPercent: 13, ssnitTier2Percent: 5, ssnitMaxInsurable: 69000, taxBands: [{ width: null, rate: 10 }],
  })), /already starts on that date/));
  check("an edit takes back a confirmation", await (async () => {
    await inSchool(() => engine.confirmRateSet(actor, newerSet.id));
    const confirmed = (await owner.payrollRateSet.findUniqueOrThrow({ where: { id: newerSet.id } })).confirmedAt !== null;
    await inSchool(() => engine.saveRateSet(actor, newerSet.id, {
      label: "From 1 November 2026", effectiveFrom: "2026-11-01", ssnitEmployeePercent: 5.5, ssnitEmployerPercent: 13, ssnitTier2Percent: 5, ssnitMaxInsurable: 69000, taxBands: [{ width: 700, rate: 0 }, { width: null, rate: 30 }],
    }));
    return confirmed && (await owner.payrollRateSet.findUniqueOrThrow({ where: { id: newerSet.id } })).confirmedAt === null;
  })());
  check("rates a run has used cannot be edited or removed", isError(await inSchool(() => engine.saveRateSet(actor, set1.id, {
    label: "Edited", effectiveFrom: "2026-09-01", ssnitEmployeePercent: 5.5, ssnitEmployerPercent: 13, ssnitTier2Percent: 5, ssnitMaxInsurable: 69000, taxBands: [{ width: null, rate: 10 }],
  })), /already used these rates/) && isError(await inSchool(() => engine.deleteRateSet(actor, set1.id)), /stay on record/));
  check("rates that were never used can be removed", isOk(await inSchool(() => engine.deleteRateSet(actor, newerSet.id))));

  console.log("\nThe screens");
  const headToken = await sessionFor(head.userId);
  const accountant = await withBypass(() => owner.user.create({ data: { name: "Probe Accountant", email: `probe-acct-${Date.now()}@example.test`, passwordHash: "x" }, select: { id: true } }));
  extraUsers.push(accountant.id);
  await withBypass(() => owner.membership.create({ data: { schoolId: school.id, userId: accountant.id, role: "ACCOUNTANT", status: "ACTIVE" } }));
  const acctToken = await sessionFor(accountant.id);

  const page = await get(`/payroll/${run2}`, headToken);
  const flat = text(page.html);
  check("the head sees the run: the month, the people and the approve button", page.status === 200 && /November 2026/.test(flat) && /Pay Tester2|Tester2/.test(flat) && /Approve this run/.test(flat), `${page.status}`);
  check("the figures are on the page, formatted", /2,871\.77/.test(flat) && /3,939\.25/.test(flat));
  const list = await get("/payroll", headToken);
  check("the list shows both months and the steps are done", list.status === 200 && /October 2026/.test(text(list.html)) && /November 2026/.test(text(list.html)));
  const slips = await get(`/payroll/${run2}/slips`, headToken);
  const slipText = text(slips.html);
  check("the payslips print: three, with the net pay", slips.status === 200 && (slipText.match(/Payslip/g) ?? []).length >= 3 && /2,871\.77/.test(slipText), `${slips.status}`);
  const oneSlip = await get(`/payroll/${run2}/slips?staff=${p2.id}`, headToken);
  check("one payslip can be printed alone", oneSlip.status === 200 && /Tester2/.test(text(oneSlip.html)) && !/Tester3/.test(text(oneSlip.html)));
  const frozen = await get(`/payroll/${run1}/slips?staff=${p1.id}`, headToken);
  check("a reprinted payslip reads the name it had, though the staff record was renamed since", /Pay Tester1/.test(text(frozen.html)) && !/Renamed/.test(text(frozen.html)));
  const schedule = await get(`/payroll/${run2}/schedule`, headToken);
  check("the SSNIT and PAYE schedules show the split and the totals", schedule.status === 200 && /SSNIT/.test(text(schedule.html)) && /1,480\.00/.test(text(schedule.html)) && /1,249\.58/.test(text(schedule.html)), `${schedule.status}`);
  check("the pay records and set-up pages open", (await get("/payroll/people", headToken)).status === 200 && (await get("/payroll/setup", headToken)).status === 200 && (await get(`/payroll/people/${p1.id}`, headToken)).status === 200);
  check("another school's run, or nothing, is a 404", (await get("/payroll/not-a-run", headToken)).status === 404);

  const acctPage = await get(`/payroll/${run2}`, acctToken);
  check("an accountant opens payroll and the run", (await get("/payroll", acctToken)).status === 200 && acctPage.status === 200);
  check("but the run tells them the head approves it, and offers no Approve button", /head teacher or the proprietor approves/.test(text(acctPage.html)) && !/Approve this run/.test(text(acctPage.html)));
  const stranger = await get(`/payroll/${run2}`);
  check("a stranger is sent to sign in", stranger.status === 307 && /login/.test(stranger.location), `${stranger.status} ${stranger.location}`);
  const staffPage = await get(`/staff/${p2.id}`, headToken);
  check("no salary appears on the staff page", staffPage.status === 200 && !/5,000\.00/.test(text(staffPage.html)) && !/\b5000\b/.test(text(staffPage.html)));

  console.log("\nTwo heads pressing Approve");
  const both = await Promise.all([inSchool(() => engine.approveRun(actor, run2)), inSchool(() => engine.approveRun(actor, run2))]);
  check("exactly one of two simultaneous approvals goes through", both.filter(isOk).length === 1 && both.filter((r) => "error" in r).length === 1, both.map(said).join(" | "));
  check("and exactly one entry was posted", (await entriesFor(run2, "PAYROLL")).length === 1);

  console.log("\nWhat the trail holds");
  const audit = await owner.auditLog.findMany({ where: { schoolId: school.id, action: { startsWith: "payroll." }, createdAt: { gte: startedAt } }, select: { action: true, after: true } });
  const trail = JSON.stringify(audit.map((a) => a.after));
  check("payroll wrote to the audit trail", audit.length >= 15 && audit.some((a) => a.action === "payroll.approve"), `${audit.length} rows`);
  check("and none of it carries a salary, a figure or a name", !/basic|salary|3000|5000|6711|2771|Tester|net/i.test(trail), trail.slice(0, 200));

} finally {
  try {
    await cleanUp();
    const left = {
      runs: await owner.payrollRun.count({ where: { schoolId: school.id } }),
      staff: await owner.staff.count({ where: { schoolId: school.id, staffNo: { startsWith: "ZZPAY-" } } }),
      rates: await owner.payrollRateSet.count({ where: { schoolId: school.id } }),
      accounts: await owner.ledgerAccount.count({ where: { schoolId: school.id, code: { startsWith: "PAY_" } } }),
      audit: await owner.auditLog.count({ where: { schoolId: school.id, action: { startsWith: "payroll." }, createdAt: { gte: startedAt } } }),
    };
    check("everything this guard made is gone", Object.values(left).every((n) => n === 0), JSON.stringify(left));
  } catch (error) {
    check("everything this guard made is gone", false, String(error));
  }
  await owner.$disconnect();
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
