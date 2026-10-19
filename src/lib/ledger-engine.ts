import "server-only";

import { Prisma, type JournalSourceType, type PaymentMethod } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { nextNumber, nextNumbers, takenProbes, takenSets } from "@/lib/sequences";
import { writeAudit } from "@/lib/audit";

type Tx = TenantTx;

export type CoreAccounts = {
  cashAccountId: string | null;
  bankAccountId: string | null;
  momoAccountId: string | null;
  receivableAccountId: string | null;
  payableAccountId: string | null;
};

/** The school's core account mappings, or all-null for a school that hasn't set them up — every caller treats that as "skip posting", never as an error. */
export async function getCoreAccounts(tx: Tx, schoolId: string): Promise<CoreAccounts> {
  const settings = await tx.schoolSettings.findUnique({
    where: { schoolId },
    select: {
      cashAccountId: true,
      bankAccountId: true,
      momoAccountId: true,
      receivableAccountId: true,
      payableAccountId: true,
    },
  });
  return (
    settings ?? {
      cashAccountId: null,
      bankAccountId: null,
      momoAccountId: null,
      receivableAccountId: null,
      payableAccountId: null,
    }
  );
}

/** Which of the school's core accounts a payment method's proceeds land in — card and cheque go through the bank, same as a deposit. */
export function cashAccountIdForMethod(core: CoreAccounts, method: PaymentMethod): string | null {
  switch (method) {
    case "CASH":
      return core.cashAccountId;
    case "MOBILE_MONEY":
      return core.momoAccountId;
    case "BANK_TRANSFER":
    case "BANK_DEPOSIT":
    case "CARD":
    case "CHEQUE":
      return core.bankAccountId;
  }
}

export type JournalLineInput = {
  accountId: string;
  debit?: Prisma.Decimal | number;
  credit?: Prisma.Decimal | number;
  description?: string;
};

/**
 * A journal entry's two rules, and the only place they are written: every line is a debit XOR a credit, and the
 * debits equal the credits. Violating either is a bug in the caller, not a business condition, so it throws.
 * Shared by `postJournalEntry` and `postJournalEntries` so the single and the bulk path cannot disagree on what a
 * valid entry is.
 */
export function assertBalanced(lines: JournalLineInput[]) {
  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  for (const line of lines) {
    const debit = new Prisma.Decimal(line.debit ?? 0);
    const credit = new Prisma.Decimal(line.credit ?? 0);
    if (debit.greaterThan(0) === credit.greaterThan(0)) {
      throw new Error(
        `Journal line for account ${line.accountId} must be a debit XOR a credit, not both or neither.`,
      );
    }
    totalDebit = totalDebit.add(debit);
    totalCredit = totalCredit.add(credit);
  }
  if (!totalDebit.equals(totalCredit)) {
    throw new Error(
      `Journal entry does not balance: debits ${totalDebit.toString()} vs credits ${totalCredit.toString()}.`,
    );
  }
}

/**
 * The one rule every call site in this codebase follows: posting is
 * ADDITIVE and BEST-EFFORT. `recalcInvoice`/`recalcVendorBill` remain the
 * sole source of truth for what is owed — this is a PARALLEL record for the
 * accountant, never a dependency of the money already working. A call site
 * decides for itself whether the accounts it needs are mapped (school
 * settings, `FeeCategory.incomeAccountId`, `ExpenseCategory.expenseAccountId`)
 * and skips posting entirely when they are not — it must never throw and
 * abort the invoice/payment/expense/bill it is actually about. This function
 * only enforces the arithmetic invariant of whatever IS submitted: debits
 * equal credits, and every line is a debit XOR a credit. Violating that is a
 * bug in the caller, not a business condition, so it throws.
 */
export async function postJournalEntry(
  tx: Tx,
  schoolId: string,
  opts: {
    sourceType: JournalSourceType;
    sourceId: string;
    memo: string;
    lines: JournalLineInput[];
    actorUserId?: string | null;
  },
) {
  if (opts.lines.length === 0) {
    return null;
  }

  assertBalanced(opts.lines);

  const entryNo = await nextNumber(tx, schoolId, "JOURNAL", takenProbes.journal(tx, schoolId));

  const entry = await tx.journalEntry.create({
    data: {
      schoolId,
      entryNo,
      memo: opts.memo,
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      postedByUserId: opts.actorUserId ?? null,
      lines: {
        create: opts.lines.map((line) => ({
          schoolId,
          accountId: line.accountId,
          debit: line.debit ?? 0,
          credit: line.credit ?? 0,
          description: line.description,
        })),
      },
    },
    include: { lines: true },
  });

  await writeAudit(tx, {
    schoolId,
    actorUserId: opts.actorUserId,
    action: "journal.post",
    entity: "JournalEntry",
    entityId: entry.id,
    after: { entryNo, sourceType: opts.sourceType, sourceId: opts.sourceId, lines: opts.lines.length },
  });

  return entry;
}

export type JournalPosting = {
  sourceType: JournalSourceType;
  sourceId: string;
  memo: string;
  lines: JournalLineInput[];
};

/** Rows per statement: a bulk insert of a few thousand lines stays well inside Postgres's bind-parameter limit. */
const CHUNK = 2000;

/**
 * Post many entries at once: the same rows `postJournalEntry` writes for each (the entry with its own number, its
 * lines, and the `journal.post` audit row), in a handful of statements instead of six or so per entry.
 *
 * Built for the invoice run, which posted one entry per pupil: 650 pupils was about four thousand statements in one
 * transaction. Every entry is validated BEFORE anything is written, as each single post validates before its own
 * write, so a bad one leaves nothing half-posted. Entries with no lines are skipped, as `postJournalEntry` returns
 * null for them. Returns how many were posted.
 */
export async function postJournalEntries(
  tx: Tx,
  schoolId: string,
  entries: JournalPosting[],
  actorUserId?: string | null,
): Promise<number> {
  const postings = entries.filter((entry) => entry.lines.length > 0);
  if (postings.length === 0) {
    return 0;
  }
  for (const posting of postings) {
    assertBalanced(posting.lines);
  }

  const numbers = await nextNumbers(tx, schoolId, "JOURNAL", postings.length, takenSets.journal(tx, schoolId));
  const created = await tx.journalEntry.createManyAndReturn({
    data: postings.map((posting, i) => ({
      schoolId,
      entryNo: numbers[i]!,
      memo: posting.memo,
      sourceType: posting.sourceType,
      sourceId: posting.sourceId,
      postedByUserId: actorUserId ?? null,
    })),
    select: { id: true, entryNo: true },
  });
  const idOf = new Map(created.map((entry) => [entry.entryNo, entry.id]));

  const lines = postings.flatMap((posting, i) =>
    posting.lines.map((line) => ({
      schoolId,
      journalEntryId: idOf.get(numbers[i]!)!,
      accountId: line.accountId,
      debit: line.debit ?? 0,
      credit: line.credit ?? 0,
      description: line.description,
    })),
  );
  for (let at = 0; at < lines.length; at += CHUNK) {
    await tx.journalLine.createMany({ data: lines.slice(at, at + CHUNK) });
  }

  const audits = postings.map((posting, i) => ({
    schoolId,
    actorUserId: actorUserId ?? null,
    action: "journal.post",
    entity: "JournalEntry",
    entityId: idOf.get(numbers[i]!)!,
    after: { entryNo: numbers[i]!, sourceType: posting.sourceType, sourceId: posting.sourceId, lines: posting.lines.length },
  }));
  for (let at = 0; at < audits.length; at += CHUNK) {
    await tx.auditLog.createMany({ data: audits.slice(at, at + CHUNK) });
  }

  return created.length;
}

/** The entry originally posted for a source row, if one was — a missing account mapping at the time means there may be none. */
export async function findJournalEntryForSource(
  tx: Tx,
  schoolId: string,
  sourceType: JournalSourceType,
  sourceId: string,
) {
  return tx.journalEntry.findFirst({
    where: { schoolId, sourceType, sourceId },
    include: { lines: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Mirror an entry's debits and credits into a new one, so a reversal is
 * itself a journal entry — never an edit or a delete of the original, which
 * would falsify a record the accountant already relied on.
 */
export async function reverseJournalEntry(
  tx: Tx,
  schoolId: string,
  originalEntryId: string,
  opts: { memo: string; actorUserId?: string | null },
) {
  const original = await tx.journalEntry.findUnique({
    where: { id: originalEntryId },
    include: { lines: true },
  });
  if (!original) {
    return null;
  }

  const entryNo = await nextNumber(tx, schoolId, "JOURNAL", takenProbes.journal(tx, schoolId));
  const entry = await tx.journalEntry.create({
    data: {
      schoolId,
      entryNo,
      memo: opts.memo,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      postedByUserId: opts.actorUserId ?? null,
      lines: {
        create: original.lines.map((line) => ({
          schoolId,
          accountId: line.accountId,
          debit: line.credit,
          credit: line.debit,
          description: line.description,
        })),
      },
    },
    include: { lines: true },
  });

  await writeAudit(tx, {
    schoolId,
    actorUserId: opts.actorUserId,
    action: "journal.reverse",
    entity: "JournalEntry",
    entityId: entry.id,
    before: { reversedEntryId: original.id, entryNo: original.entryNo },
    after: { entryNo },
  });

  return entry;
}
