import "server-only";

import { Prisma, type JournalSourceType, type PaymentMethod } from "@prisma/client";
import type { TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
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

  let totalDebit = new Prisma.Decimal(0);
  let totalCredit = new Prisma.Decimal(0);
  for (const line of opts.lines) {
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
