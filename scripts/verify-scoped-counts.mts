/**
 * The scoped counts equal Prisma's relation counts, and the indexes they depend on exist.
 *
 *   npm run verify:scoped-counts
 *
 * The dashboard's marking rule, the assessments list, the Fees page and the chart of accounts used Prisma's
 * relation `_count`, which aggregates the WHOLE child table (every school's rows) and then picks out the ones
 * asked for: about 190 ms for the score count at ten schools, growing with every school and every year. They now
 * use `scoped-counts.ts`, which counts only the ids on the page, through an index. The numbers are shown to
 * people (how many scores an assessment holds, how many lines a fee item has been billed on), so "faster" is only
 * acceptable if every number is the same. This compares them, row for row, against the `_count` they replaced.
 *
 * The seeded school has no journal lines, so those are built inside a transaction that is rolled back (a mapped
 * chart of accounts and a billed term), and the comparison runs against that transaction's rows. Without it the
 * journal check would compare nothing with nothing and pass for any code.
 *
 * Also checks the indexes. Row security is an OR that Postgres cannot turn into an index condition, so a query is
 * only as indexed as its own `where`; the counts, and the parent portal's queries, depend on an index that LEADS
 * with the column they filter on. The planner will not pick them on the seeded school's few dozen rows, so this
 * asserts they EXIST (in the database CI built from the migrations), not that a plan uses them.
 *
 * Development databases only, like every guard that reads the seed.
 */
import { PrismaClient } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { generateInvoicesForTerm } from "@/lib/invoice-engine";
import { invoiceItemsPerCategory, journalActivityPerAccount, scoresPerAssessment, structureItemsPerCategory } from "@/lib/scoped-counts";
import { demoSchool } from "./fixture.mjs";

const db = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}
class Rollback extends Error {}

const school = await demoSchool();

/** The first difference between a reference map and a helper's map, or "" when they agree on EVERY id (a missing id means zero). */
function differ(ids: string[], reference: Map<string, number>, got: Map<string, number>) {
  for (const id of ids) {
    if ((reference.get(id) ?? 0) !== (got.get(id) ?? 0)) return `${id}: _count says ${reference.get(id) ?? 0}, scoped says ${got.get(id) ?? 0}`;
  }
  return "";
}

console.log("Scores per assessment");
{
  const reference = await db.assessment.findMany({ where: { schoolId: school.id }, select: { id: true, _count: { select: { scores: true } } } });
  const ids = reference.map((row) => row.id);
  const want = new Map(reference.map((row) => [row.id, row._count.scores]));
  const got = await scoresPerAssessment(ids, db as unknown as TenantTx);
  check(`all ${ids.length} of the school's assessments`, ids.length > 0 && differ(ids, want, got) === "", differ(ids, want, got));
  check("and there is something to count (otherwise this proves nothing)", [...want.values()].some((n) => n > 0));
  check("an assessment with no scores is zero, not missing", [...want.values()].includes(0) ? (got.get([...want].find(([, n]) => n === 0)![0]) ?? 0) === 0 : true);
  const one = ids[0]!;
  check("asking for one assessment counts only that one", (await scoresPerAssessment([one], db as unknown as TenantTx)).size <= 1);
  check("an empty list asks nothing and answers nothing", (await scoresPerAssessment([], db as unknown as TenantTx)).size === 0);
  check("a repeated id is counted once, not twice", (await scoresPerAssessment([one, one, one], db as unknown as TenantTx)).get(one) === (want.get(one) || undefined));
}

console.log("\nFee items: priced on structures, billed on invoice lines");
{
  const reference = await db.feeCategory.findMany({ where: { schoolId: school.id }, select: { id: true, _count: { select: { structureItems: true, invoiceItems: true } } } });
  const ids = reference.map((row) => row.id);
  const priced = new Map(reference.map((row) => [row.id, row._count.structureItems]));
  const billed = new Map(reference.map((row) => [row.id, row._count.invoiceItems]));
  check(`structure lines for all ${ids.length} fee items`, differ(ids, priced, await structureItemsPerCategory(ids, db as unknown as TenantTx)) === "", differ(ids, priced, await structureItemsPerCategory(ids, db as unknown as TenantTx)));
  check("invoice lines for all of them", differ(ids, billed, await invoiceItemsPerCategory(ids, db as unknown as TenantTx)) === "", differ(ids, billed, await invoiceItemsPerCategory(ids, db as unknown as TenantTx)));
  check("and both have something to count", [...priced.values()].some((n) => n > 0) && [...billed.values()].some((n) => n > 0));
}

console.log("\nJournal lines per account, on a ledger built inside a transaction that is rolled back");
try {
  await db.$transaction(
    async (tx) => {
      // A mapped chart of accounts and a billed term, so there ARE journal lines to count.
      const receivable = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "1100-S", name: "Fees receivable", type: "ASSET" } });
      const income = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "4100-S", name: "Tuition income", type: "INCOME" } });
      const idle = await tx.ledgerAccount.create({ data: { schoolId: school.id, code: "4999-S", name: "Never used", type: "INCOME" } });
      for (const category of await tx.feeCategory.findMany({ where: { schoolId: school.id } })) {
        await tx.feeCategory.update({ where: { id: category.id }, data: { incomeAccountId: income.id } });
      }
      await tx.schoolSettings.update({ where: { schoolId: school.id }, data: { receivableAccountId: receivable.id } });
      const term = await tx.term.findFirstOrThrow({ where: { schoolId: school.id, isCurrent: true } });
      await tx.invoice.deleteMany({ where: { schoolId: school.id, termId: term.id } });
      await generateInvoicesForTerm(tx as unknown as TenantTx, school.id, term.id, 14, null);

      const accounts = await tx.ledgerAccount.findMany({ where: { schoolId: school.id }, include: { _count: { select: { journalLines: true } } } });
      const sums = await tx.journalLine.groupBy({ by: ["accountId"], where: { schoolId: school.id }, _sum: { debit: true, credit: true } });
      const ids = accounts.map((a) => a.id);
      const got = await journalActivityPerAccount(ids, tx as unknown as TenantTx);

      const lines = new Map(accounts.map((a) => [a.id, a._count.journalLines]));
      const gotLines = new Map([...got].map(([id, a]) => [id, a.lines]));
      check(`line counts for all ${ids.length} accounts`, differ(ids, lines, gotLines) === "", differ(ids, lines, gotLines));
      check("and the receivable account really holds lines", (lines.get(receivable.id) ?? 0) > 0 && (lines.get(income.id) ?? 0) > 0);
      check("an account nobody posted to is zero, not missing", (lines.get(idle.id) ?? 0) === 0 && (got.get(idle.id)?.lines ?? 0) === 0);
      const debit = (id: string) => Number(sums.find((s) => s.accountId === id)?._sum.debit ?? 0);
      const credit = (id: string) => Number(sums.find((s) => s.accountId === id)?._sum.credit ?? 0);
      check("debit totals equal the whole-table grouping", ids.every((id) => Math.abs((got.get(id)?.debit ?? 0) - debit(id)) < 0.005), "");
      check("credit totals equal the whole-table grouping", ids.every((id) => Math.abs((got.get(id)?.credit ?? 0) - credit(id)) < 0.005), "");
      check("the books still balance (debits = credits)", Math.abs([...got.values()].reduce((n, a) => n + a.debit - a.credit, 0)) < 0.005);
      throw new Rollback();
    },
    { timeout: 300_000, maxWait: 30_000 },
  );
} catch (error) {
  if (!(error instanceof Rollback)) {
    console.error(error);
    failures += 1;
  }
}

console.log("\nThe indexes these depend on (an index that LEADS with the filtered column)");
{
  const rows = await db.$queryRaw<{ tablename: string; indexdef: string }[]>`
    select tablename, indexdef from pg_indexes where schemaname = 'public'
      and tablename in ('Score', 'InvoiceItem', 'JournalLine', 'TermResult', 'Payment', 'FeeStructureItem')`;
  const leads = (table: string, column: string) =>
    rows.some((row) => row.tablename === table && new RegExp(`\\(\\s*"${column}"[,)]`).test(row.indexdef));
  check("Score leads with assessmentId (the unique on assessment + pupil)", leads("Score", "assessmentId"));
  check("InvoiceItem leads with feeCategoryId", leads("InvoiceItem", "feeCategoryId"));
  check("JournalLine leads with accountId", leads("JournalLine", "accountId"));
  check("TermResult leads with studentId (the parent portal's report cards)", leads("TermResult", "studentId"));
  check("Payment leads with studentId (the parent portal's balance and receipts)", leads("Payment", "studentId"));
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
