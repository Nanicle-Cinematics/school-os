import "server-only";

import { prisma, type TenantTx } from "@/lib/prisma";

/**
 * Counts per parent that read ONLY the rows of the parents you name, through an index.
 *
 * Prisma's relation count (`_count: { select: { scores: true } }`) is written as a join to
 * `SELECT parentId, COUNT(*) FROM child GROUP BY parentId` over the WHOLE child table, and that
 * subquery is not narrowed by the parents being selected or by row security. So on a database
 * holding ten schools, the dashboard's marking rule counted every school's scores (about 190 ms
 * for 450,000 rows, and growing with every school and every year), then threw nine tenths of the
 * answer away. The same shape sat under the Fees page and the chart of accounts. These ask only
 * about the ids on the page: an indexed read whose cost follows the page and not the database.
 *
 * ⚠️ Each one relies on an index that LEADS with the column it filters on (`Score` by assessment,
 * `InvoiceItem` by fee category, `JournalLine` by account). Row security is an OR of the bypass
 * flag and the school, which Postgres cannot turn into an index condition, so a query is only as
 * indexed as its own `where`. `verify:scoped-counts` checks the indexes exist.
 *
 * `db` is for scripts that must see a transaction's uncommitted rows; the app never passes it.
 */
type Db = typeof prisma;
const client = (db?: TenantTx): Db => (db ?? prisma) as unknown as Db;

/** An `IN (...)` list of a few thousand is fine; past that, ask in slices rather than send one enormous statement. */
const SLICE = 1000;
function slices<T>(items: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += SLICE) out.push(items.slice(i, i + SLICE));
  return out;
}

export type CountMap = Map<string, number>;

/** How many scores each assessment holds. */
export async function scoresPerAssessment(assessmentIds: string[], db?: TenantTx): Promise<CountMap> {
  const counts: CountMap = new Map();
  for (const ids of slices([...new Set(assessmentIds)])) {
    const rows = await client(db).score.groupBy({ by: ["assessmentId"], where: { assessmentId: { in: ids } }, _count: { _all: true } });
    for (const row of rows) counts.set(row.assessmentId, row._count._all);
  }
  return counts;
}

/** How many fee-structure lines price each fee item. */
export async function structureItemsPerCategory(feeCategoryIds: string[], db?: TenantTx): Promise<CountMap> {
  const counts: CountMap = new Map();
  for (const ids of slices([...new Set(feeCategoryIds)])) {
    const rows = await client(db).feeStructureItem.groupBy({ by: ["feeCategoryId"], where: { feeCategoryId: { in: ids } }, _count: { _all: true } });
    for (const row of rows) counts.set(row.feeCategoryId, row._count._all);
  }
  return counts;
}

/** How many invoice lines each fee item has been billed on. */
export async function invoiceItemsPerCategory(feeCategoryIds: string[], db?: TenantTx): Promise<CountMap> {
  const counts: CountMap = new Map();
  for (const ids of slices([...new Set(feeCategoryIds)])) {
    const rows = await client(db).invoiceItem.groupBy({ by: ["feeCategoryId"], where: { feeCategoryId: { in: ids } }, _count: { _all: true } });
    for (const row of rows) {
      if (row.feeCategoryId) counts.set(row.feeCategoryId, row._count._all);
    }
  }
  return counts;
}

export type AccountActivity = { lines: number; debit: number; credit: number };

/** Each account's journal lines and what they add up to, for the accounts named. */
export async function journalActivityPerAccount(accountIds: string[], db?: TenantTx): Promise<Map<string, AccountActivity>> {
  const activity = new Map<string, AccountActivity>();
  for (const ids of slices([...new Set(accountIds)])) {
    const rows = await client(db).journalLine.groupBy({
      by: ["accountId"],
      where: { accountId: { in: ids } },
      _count: { _all: true },
      _sum: { debit: true, credit: true },
    });
    for (const row of rows) {
      activity.set(row.accountId, { lines: row._count._all, debit: Number(row._sum.debit ?? 0), credit: Number(row._sum.credit ?? 0) });
    }
  }
  return activity;
}
