/**
 * The batched invoice run writes the SAME rows the one-at-a-time run did, in a few statements instead of thousands.
 *
 *   npm run verify:invoice-batch
 *
 * `generateInvoicesForTerm` used to bill one pupil at a time: a number, the invoice and its lines, a journal entry
 * with a number of its own, an audit row, a carried-forward check. About ten statements a pupil, so a school of 650
 * was 7.5 CPU-seconds inside one transaction holding one of the app role's four connections. It is now a handful
 * of bulk statements. Money moves through this, so "faster" is only acceptable if it is IDENTICAL, and the way to
 * know is to run the original (kept as scripts/invoice-engine.reference.mts, built on the engine's own pricing and
 * the single-row helpers the rest of the app still uses) and the new one from the SAME starting state and compare
 * every row they leave behind.
 *
 * Each scenario runs the old engine in one transaction and the new in another, from the same committed state, and
 * rolls both back, so the database is left exactly as found. What is compared, keyed by what is stable (a pupil's
 * admission number, never a generated id): every invoice and its lines, the brought-forward chain across ALL terms,
 * every journal entry with its lines, the `journal.post` audit rows, the allocated numbers and where the two
 * counters end up.
 *
 * The seeded school has no chart of accounts and no discounts, so the setups make them (inside the rolled-back
 * transactions): without that the journal path and the discount arithmetic would go unexercised and a green run
 * would prove nothing about them.
 *
 * Development databases only, like every guard that reads the seed.
 */
import { Prisma, PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { generateInvoicesForTerm } from "@/lib/invoice-engine";
import { demoSchool } from "./fixture.mjs";
import { generateInvoicesForTermReference } from "./invoice-engine.reference.mjs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}

class Rollback extends Error {}
type Engine = (tx: TenantTx, schoolId: string, termId: string, dueDays: number, actorUserId?: string | null) => Promise<unknown>;

/** The transaction, counting every call made on any model: statements, give or take Prisma's own nesting. */
function counted(tx: unknown, tally: { ops: number }) {
  return new Proxy(tx as object, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      if (typeof key === "string" && value && typeof value === "object" && !key.startsWith("$")) {
        return new Proxy(value as object, {
          get(model, op, r) {
            const fn = Reflect.get(model, op, r);
            if (typeof fn !== "function") return fn;
            return (...args: unknown[]) => {
              tally.ops += 1;
              return fn.apply(model, args);
            };
          },
        });
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as TenantTx;
}

const school = await demoSchool();
const terms = await db.term.findMany({ where: { schoolId: school.id }, orderBy: [{ academicYear: { startDate: "asc" } }, { sequence: "asc" }] });
const withInvoices = await db.invoice.groupBy({ by: ["termId"], where: { schoolId: school.id }, _count: true });
const billed = terms.filter((t) => withInvoices.some((g) => g.termId === t.id));
const earlier = billed[0];
const laterOrNone = terms.find((t) => t.id !== earlier?.id && (earlier ? t.startDate > earlier.startDate : true));
if (!earlier || !laterOrNone) {
  console.log("  FAIL the seeded school needs one billed term and a later one to bill");
  process.exit(1);
}
const later = laterOrNone;
const students = await db.student.findMany({ where: { schoolId: school.id, status: "ACTIVE", deletedAt: null }, orderBy: { admissionNo: "asc" }, select: { id: true, admissionNo: true } });
console.log(`${school.slug}: ${students.length} pupils; billing "${later.name}" after "${earlier.name}"`);

/* ── What a scenario can change before the run (all rolled back) ────────────────────────────────────────── */

type Setup = (tx: PrismaClientTx) => Promise<void>;
type PrismaClientTx = Prisma.TransactionClient;

/** Remove a term's invoices (all but one pupil's, if asked), and the journal entries posted for them, so the term can be billed afresh. */
async function unbill(tx: PrismaClientTx, termId: string, except?: string) {
  const ids = (await tx.invoice.findMany({ where: { schoolId: school.id, termId, ...(except ? { studentId: { not: except } } : {}) }, select: { id: true } })).map((i) => i.id);
  await tx.journalEntry.deleteMany({ where: { schoolId: school.id, sourceType: "INVOICE", sourceId: { in: ids } } });
  await tx.invoice.deleteMany({ where: { id: { in: ids } } });
}

/** Bill a term with the ORIGINAL engine, to build a starting state (the same one for both runs being compared). */
const billWithReference = (termId: string): Setup => async (tx) => {
  await generateInvoicesForTermReference(tx as unknown as TenantTx, school.id, termId, 14, null);
};

/** A chart of accounts, mapped: receivable, and an income account for every fee category but the LAST (a partly set-up school). */
async function mapLedger(tx: PrismaClientTx) {
  const receivable = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "1100-V", name: "Fees receivable", type: "ASSET" } });
  const income = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "4100-V", name: "Tuition income", type: "INCOME" } });
  const other = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "4200-V", name: "Other income", type: "INCOME" } });
  const categories = await tx.feeCategory.findMany({ where: { schoolId: school.id }, orderBy: { order: "asc" } });
  for (const [i, category] of categories.entries()) {
    if (i === categories.length - 1) continue;
    await tx.feeCategory.update({ where: { id: category.id }, data: { incomeAccountId: i % 2 === 0 ? income.id : other.id } });
  }
  await tx.schoolSettings.update({ where: { schoolId: school.id }, data: { receivableAccountId: receivable.id } });
}

/** A percentage discount on three pupils, a fixed one on a fourth, and a fixed one capped by a small line. */
async function addDiscounts(tx: PrismaClientTx) {
  const year = later.academicYearId;
  const categories = await tx.feeCategory.findMany({ where: { schoolId: school.id }, orderBy: { order: "asc" }, take: 2 });
  const pct = await tx.discount.create({ data: { schoolId: school.id, name: "V sibling 10%", type: "PERCENTAGE", value: 10, reason: "SIBLING" } });
  const fixed = await tx.discount.create({ data: { schoolId: school.id, name: "V bursary 50", type: "FIXED", value: 50, reason: "BURSARY", appliesToCategoryId: categories[0]!.id } });
  const huge = await tx.discount.create({ data: { schoolId: school.id, name: "V bigger than the line", type: "FIXED", value: 100000, reason: "SCHOLARSHIP" } });
  for (const s of students.slice(0, 3)) await tx.studentDiscount.create({ data: { schoolId: school.id, studentId: s.id, discountId: pct.id, academicYearId: year } });
  await tx.studentDiscount.create({ data: { schoolId: school.id, studentId: students[3]!.id, discountId: fixed.id, academicYearId: year } });
  await tx.studentDiscount.create({ data: { schoolId: school.id, studentId: students[4]!.id, discountId: huge.id, academicYearId: year } });
}

/**
 * Leave numbers already taken just ahead of both counters, so the allocator has to walk past them. The invoice
 * counter is put 100 below the highest number in use: 100 collisions, which is more than a counter that has fallen
 * behind imported records by hand ever does and under the 200 the ORIGINAL allocator tolerates in a row (a longer
 * run made it throw, which would have failed this guard in the reference, not in the code under test).
 */
async function collideNumbers(tx: PrismaClientTx) {
  const used = await tx.invoice.findMany({ where: { schoolId: school.id }, select: { invoiceNo: true } });
  const highest = Math.max(0, ...used.map((i) => Number(i.invoiceNo.replace(/\D/g, "")) || 0));
  if (highest === 0) throw new Error("no existing invoices to collide with");
  await tx.numberSequence.updateMany({ where: { schoolId: school.id, key: "INVOICE" }, data: { next: Math.max(1, highest - 99) } });

  // The journal counter goes back to the start, where four entries already sit.
  await tx.numberSequence.updateMany({ where: { schoolId: school.id, key: "JOURNAL" }, data: { next: 1 } });
  const account = await tx.ledgerAccount.findFirstOrThrow({ where: { schoolId: school.id, code: "1100-V" } });
  for (let n = 1; n <= 4; n += 1) {
    const entryNo = `JE-${String(n).padStart(6, "0")}`;
    if (!(await tx.journalEntry.findFirst({ where: { schoolId: school.id, entryNo } }))) {
      await tx.journalEntry.create({ data: { schoolId: school.id, entryNo, memo: "V collision", sourceType: "PAYMENT", sourceId: `v-${n}`, lines: { create: [{ schoolId: school.id, accountId: account.id, debit: 1 }, { schoolId: school.id, accountId: account.id, credit: 1 }] } } });
    }
  }
}

/** A pupil with no class cannot be billed: the result must name them, identically. */
async function strandAPupil(tx: PrismaClientTx) {
  await tx.student.update({ where: { id: students[5]!.id }, data: { currentClassGroupId: null } });
}

/* ── Snapshot: everything the run leaves behind, by stable keys ────────────────────────────────────────── */

const dec = (v: Prisma.Decimal | null | undefined) => (v === null || v === undefined ? null : v.toFixed(2));
async function snapshot(tx: PrismaClientTx) {
  const nameOf = new Map(students.map((s) => [s.id, s.admissionNo]));
  const invoices = await tx.invoice.findMany({ where: { schoolId: school.id }, include: { items: true, term: true }, orderBy: [{ studentId: "asc" }, { termId: "asc" }] });
  const invoiceKey = new Map(invoices.map((i) => [i.id, `${nameOf.get(i.studentId)}|${i.term.sequence}|${i.termId.slice(-6)}`]));
  const entries = await tx.journalEntry.findMany({ where: { schoolId: school.id }, include: { lines: true }, orderBy: { entryNo: "asc" } });
  const audits = await tx.auditLog.findMany({ where: { schoolId: school.id, action: "journal.post" } });
  const entryNoOf = new Map(entries.map((e) => [e.id, e.entryNo]));
  // The setups make their own ledger accounts afresh in every transaction, so their ids differ between runs: by code.
  const codeOf = new Map((await tx.ledgerAccount.findMany({ where: { schoolId: school.id }, select: { id: true, code: true } })).map((a) => [a.id, a.code]));
  const sequences = await tx.numberSequence.findMany({ where: { schoolId: school.id, key: { in: ["INVOICE", "JOURNAL"] } }, orderBy: { key: "asc" } });
  return JSON.stringify({
    invoices: invoices
      .map((i) => [
        invoiceKey.get(i.id), i.invoiceNo, i.status, dec(i.subtotal), dec(i.discountTotal), dec(i.broughtForward), dec(i.total), dec(i.amountPaid), dec(i.balance), i.billCodeId,
        i.dueDate?.toISOString().slice(0, 10) ?? null,
        i.items.map((x) => [x.description, dec(x.amount), dec(x.discount), x.feeCategoryId]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    journal: entries.map((e) => [
      e.entryNo, e.memo, e.sourceType, e.sourceType === "INVOICE" ? invoiceKey.get(e.sourceId) ?? "?" : e.sourceId, e.postedByUserId,
      e.lines.map((l) => [codeOf.get(l.accountId) ?? l.accountId, dec(l.debit), dec(l.credit), l.description]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    ]),
    // The audit row's JSON names the invoice by its generated id: keyed by the pupil instead, and with its keys in order.
    // Rows left over from entries a setup deleted point at nothing and say nothing about the run.
    audits: audits
      .filter((a) => entryNoOf.has(a.entityId))
      .map((a) => {
        const after = (a.after ?? {}) as Record<string, unknown>;
        const stable = { ...after, sourceId: after.sourceType === "INVOICE" ? invoiceKey.get(String(after.sourceId)) ?? "?" : after.sourceId };
        return [entryNoOf.get(a.entityId), a.entity, a.actorUserId, JSON.stringify(Object.fromEntries(Object.entries(stable).sort(([x], [y]) => x.localeCompare(y))))];
      })
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    sequences: sequences.map((s) => [s.key, s.prefix, s.padding, s.next]),
  });
}

/** Run one engine from the scenario's starting state, then undo everything. */
async function once(engine: Engine, termId: string, setups: Setup[], then?: (tx: PrismaClientTx, run: () => Promise<unknown>) => Promise<unknown>) {
  const outcome: { snap: string; result: unknown; ops: number; second?: unknown } = { snap: "", result: null, ops: 0 };
  try {
    await db.$transaction(
      async (tx) => {
        for (const setup of setups) await setup(tx);
        const tally = { ops: 0 };
        const run = () => engine(counted(tx, tally), school.id, termId, 14, null);
        outcome.result = await run();
        outcome.ops = tally.ops;
        if (then) outcome.second = await then(tx, run);
        outcome.snap = await snapshot(tx);
        throw new Rollback();
      },
      { timeout: 600_000, maxWait: 30_000 },
    );
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return outcome;
}

async function compare(label: string, termId: string, setups: Setup[], opts: { expectInvoices?: number; expectEntries?: boolean } = {}) {
  const was = await once(generateInvoicesForTermReference as Engine, termId, setups);
  const now = await once(generateInvoicesForTerm as Engine, termId, setups);
  const parsed = JSON.parse(now.snap) as { invoices: unknown[]; journal: unknown[]; audits: unknown[] };
  check(`${label}: the same invoices, lines, journal entries, audit rows and counters`, was.snap === now.snap, firstDifference(was.snap, now.snap));
  check(`${label}: the same result (created, skipped, who could not be billed)`, JSON.stringify(was.result) === JSON.stringify(now.result), `${JSON.stringify(was.result).slice(0, 120)} vs ${JSON.stringify(now.result).slice(0, 120)}`);
  if (opts.expectInvoices !== undefined) check(`${label}: it really billed ${opts.expectInvoices} pupils (otherwise this proves nothing)`, (now.result as { created: number }).created === opts.expectInvoices, JSON.stringify(now.result).slice(0, 100));
  if (opts.expectEntries !== undefined) check(`${label}: ${opts.expectEntries ? "journal entries were posted, with audit rows" : "no journal entries were posted for these invoices"}`, opts.expectEntries ? parsed.audits.length > 0 && parsed.journal.length > 0 : !JSON.stringify(parsed.journal).includes('"INVOICE"'), `${parsed.journal.length} entries, ${parsed.audits.length} audits`);
  console.log(`        statements: ${was.ops} before, ${now.ops} now (${(now.result as { created: number }).created} invoices)`);
  return { was, now };
}

function firstDifference(a: string, b: string) {
  if (a === b) return "";
  const x = JSON.parse(a) as Record<string, unknown[]>;
  const y = JSON.parse(b) as Record<string, unknown[]>;
  for (const key of Object.keys(x)) {
    if (JSON.stringify(x[key]) !== JSON.stringify(y[key])) {
      const i = (x[key] ?? []).findIndex((row, at) => JSON.stringify(row) !== JSON.stringify((y[key] ?? [])[at]));
      return `${key}[${i}] ${JSON.stringify((x[key] ?? [])[i])} vs ${JSON.stringify((y[key] ?? [])[i])} (${(x[key] ?? []).length} vs ${(y[key] ?? []).length} rows)`;
    }
  }
  return "differs";
}

const unbillLater: Setup = (tx) => unbill(tx, later.id);
const unbillEarlier: Setup = (tx) => unbill(tx, earlier.id);
const N = students.length;

console.log("\nA term with nothing billed, no chart of accounts");
await compare("no ledger", later.id, [unbillLater], { expectInvoices: N, expectEntries: false });

console.log("\nA mapped chart of accounts (one fee category left unmapped), with arrears carried from the earlier term");
await compare("ledger + arrears", later.id, [unbillLater, mapLedger], { expectInvoices: N, expectEntries: true });

console.log("\nDiscounts: percentage, fixed on one category, and one bigger than the line");
await compare("discounts", later.id, [unbillLater, mapLedger, addDiscounts], { expectInvoices: N, expectEntries: true });

console.log("\nBilling an EARLIER term after a later one exists (the later one's brought-forward must be re-linked)");
{
  // Bill the later term while the earlier one is billed (it carries arrears), then take the earlier term's invoices
  // away: the later ones now carry arrears from nothing. Billing the earlier term again must re-link them.
  const setups: Setup[] = [unbillLater, mapLedger, billWithReference(later.id), unbillEarlier];
  const { now } = await compare("earlier after later", earlier.id, setups, { expectInvoices: N, expectEntries: true });
  void now;
}

console.log("\nNumbers that are already taken: both counters start where existing records are");
await compare("collisions", later.id, [unbillLater, mapLedger, collideNumbers], { expectInvoices: N, expectEntries: true });

console.log("\nA pupil with no class, and a pupil who is already billed");
{
  const keepSeventh: Setup = (tx) => unbill(tx, later.id, students[6]!.id);
  const { now } = await compare("skips", later.id, [unbillLater, mapLedger, billWithReference(later.id), keepSeventh, strandAPupil], { expectEntries: true });
  const result = now.result as { created: number; skipped: number; noStructure: unknown[] };
  check("skips: one pupil skipped as already billed and one named as having no class", result.skipped === 1 && result.noStructure.length === 1 && result.created === N - 2, JSON.stringify(result).slice(0, 160));
}

console.log("\nRunning it twice, and how few statements it takes");
{
  const settled = await once(generateInvoicesForTerm as Engine, later.id, [unbillLater, mapLedger], async (_tx, run) => run());
  const second = settled.second as { created: number; skipped: number };
  check("a second run bills nobody", second.created === 0 && second.skipped === N, JSON.stringify(second));
  check(`one run is a few dozen statements, not hundreds (${settled.ops} for ${N} pupils)`, settled.ops <= 40, `${settled.ops}`);
  const reference = await once(generateInvoicesForTermReference as Engine, later.id, [unbillLater, mapLedger]);
  check("and at least 8 times fewer than the one-at-a-time run", settled.ops * 8 <= reference.ops, `${settled.ops} vs ${reference.ops}`);
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
