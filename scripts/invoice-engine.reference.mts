/**
 * THE ORIGINAL invoice run, kept as the oracle for `verify:invoice-batch`. Not used by the app.
 *
 * `generateInvoicesForTerm` used to be exactly this: about ten statements per pupil (a number, the invoice with its
 * lines, a journal entry with a number of its own, an audit row, a carried-forward check). It was batched because
 * 650 pupils was about 7.5 CPU-seconds in one transaction. The batched version must write the SAME rows, and the way
 * to know that is to run both on the same data and compare. So this is the old persistence strategy and nothing
 * else: it calls the engine's own pricing and fee-structure choice, and the single-row helpers (`nextNumber`,
 * `postJournalEntry`, `syncCarriedForward`) that the payment and reversal flows still use, so it cannot drift from
 * what the rest of the app does and the pricing rules are never duplicated here.
 */
import { Prisma } from "@prisma/client";
import { money } from "@/lib/money";
import type { TenantTx } from "@/lib/prisma";
import { nextNumber, takenProbes } from "@/lib/sequences";
import { getCoreAccounts, postJournalEntry } from "@/lib/ledger-engine";
import {
  chooseFeeStructure,
  explainNoStructure,
  priceFromStructure,
  syncCarriedForward,
  type GenerationResult,
} from "@/lib/invoice-engine";

type Tx = TenantTx;

/**
 * Build term invoices for every active student who doesn't already have one.
 *
 * Idempotent by design — Invoice is unique on (studentId, termId), and we skip
 * rather than error, so a bursar can safely re-run it after admitting a few
 * more students mid-term.
 */
export async function generateInvoicesForTermReference(
  tx: Tx,
  schoolId: string,
  termId: string,
  dueDays: number,
  actorUserId?: string | null,
): Promise<GenerationResult> {
  const term = await tx.term.findUniqueOrThrow({
    where: { id: termId },
    include: { academicYear: true },
  });

  const students = await tx.student.findMany({
    where: { schoolId, status: "ACTIVE", deletedAt: null },
    include: {
      currentClassGroup: { select: { levelId: true, level: { select: { name: true } } } },
      invoices: { where: { termId }, select: { id: true } },
      discounts: {
        where: { academicYearId: term.academicYearId },
        include: { discount: true },
      },
    },
    orderBy: { admissionNo: "asc" },
  });

  const structures = await tx.feeStructure.findMany({
    where: { schoolId, academicYearId: term.academicYearId, isActive: true },
    include: { items: { include: { feeCategory: true } } },
  });

  /**
   * What each pupil still owed from before this term.
   *
   * The pupil's most recent EARLIER invoice, wherever it falls: the previous term
   * of the same year, or — for term 1 — the last term of the year before. The
   * old lookup only ever looked for `sequence - 1` in the SAME year, so arrears
   * stopped at the new year's door and the new bill silently omitted them.
   * One earlier invoice is enough because it already carries everything before
   * it (see syncCarriedForward).
   */
  const earlier = await tx.invoice.findMany({
    where: {
      schoolId,
      termId: { not: termId },
      status: { not: "CANCELLED" },
      studentId: { in: students.map((student) => student.id) },
    },
    select: {
      studentId: true,
      balance: true,
      term: { select: { sequence: true, academicYear: { select: { startDate: true } } } },
    },
  });
  const thisStart = term.academicYear.startDate.getTime();
  const latestBefore = new Map<string, { at: [number, number]; balance: Prisma.Decimal }>();
  for (const row of earlier) {
    const at: [number, number] = [row.term.academicYear.startDate.getTime(), row.term.sequence];
    const isEarlier = at[0] < thisStart || (at[0] === thisStart && at[1] < term.sequence);
    if (!isEarlier) continue;
    const seen = latestBefore.get(row.studentId);
    if (!seen || at[0] > seen.at[0] || (at[0] === seen.at[0] && at[1] > seen.at[1])) {
      latestBefore.set(row.studentId, { at, balance: row.balance });
    }
  }
  const previousBalances = new Map(
    [...latestBefore].map(([studentId, row]) => [
      studentId,
      row.balance.greaterThan(0) ? row.balance : new Prisma.Decimal(0),
    ]),
  );

  const dueDate = new Date(term.startDate);
  dueDate.setDate(dueDate.getDate() + dueDays);

  // A school provisioned before bill codes existed may not have TERMBILL yet —
  // generation must not fail over a missing classification, so this stays
  // optional rather than throwing when it's absent.
  const termBillCode = await tx.billCode.findUnique({
    where: { schoolId_code: { schoolId, code: "TERMBILL" } },
    select: { id: true },
  });

  // Ledger posting is additive and best-effort — a school that hasn't set up
  // its chart of accounts yet still generates invoices exactly as before.
  // See ledger-engine.ts.
  const core = await getCoreAccounts(tx, schoolId);
  const incomeAccountByFeeCategory = new Map(
    structures.flatMap((s) => s.items.map((item) => [item.feeCategoryId, item.feeCategory.incomeAccountId])),
  );

  const result: GenerationResult = { created: 0, skipped: 0, noStructure: [] };

  for (const student of students) {
    if (student.invoices.length > 0) {
      result.skipped += 1;
      continue;
    }

    const who = {
      admissionNo: student.admissionNo,
      name: `${student.firstName} ${student.lastName}`,
    };

    const levelId = student.currentClassGroup?.levelId;
    if (!levelId) {
      result.noStructure.push({ ...who, reason: { kind: "NO_CLASS" } });
      continue;
    }

    const profile = {
      residency: student.residency,
      isNew: student.admissionDate ? student.admissionDate >= term.academicYear.startDate : false,
    };
    const levelStructures = structures.filter((s) => s.levelId === levelId);
    const structure = chooseFeeStructure(levelStructures, profile, termId);

    if (!structure) {
      const level = student.currentClassGroup?.level?.name ?? "their level";
      result.noStructure.push({
        ...who,
        reason: explainNoStructure(levelStructures, profile, termId, level),
      });
      continue;
    }

    const priced = priceFromStructure(
      schoolId,
      structure,
      student.discounts.map((sd) => sd.discount),
      previousBalances.get(student.id) ?? new Prisma.Decimal(0),
    );
    const { lines, subtotal, discountTotal, broughtForward, total } = priced;

    const invoiceNo = await nextNumber(tx, schoolId, "INVOICE", takenProbes.invoice(tx, schoolId));

    const invoice = await tx.invoice.create({
      data: {
        schoolId,
        studentId: student.id,
        termId,
        billCodeId: termBillCode?.id,
        invoiceNo,
        issueDate: new Date(),
        dueDate,
        subtotal,
        discountTotal,
        broughtForward,
        total,
        amountPaid: money(0),
        balance: total,
        status: "ISSUED",
        items: { create: lines },
      },
    });

    // Dr Accounts Receivable / Cr each line's income account, net of its
    // discount — only for the slice of the bill that IS mapped, so a
    // partially-configured chart of accounts posts a smaller, still-balanced
    // entry rather than an incomplete one. broughtForward is deliberately
    // excluded: that arrears was already posted when the PRIOR invoice was
    // raised, and posting it again would double it.
    if (core.receivableAccountId) {
      const creditByAccount = new Map<string, Prisma.Decimal>();
      for (const line of lines) {
        const incomeAccountId = incomeAccountByFeeCategory.get(line.feeCategoryId);
        if (!incomeAccountId) continue;
        const net = line.amount.sub(line.discount);
        creditByAccount.set(incomeAccountId, (creditByAccount.get(incomeAccountId) ?? new Prisma.Decimal(0)).add(net));
      }
      const mappedTotal = [...creditByAccount.values()].reduce((a, b) => a.add(b), new Prisma.Decimal(0));
      if (mappedTotal.greaterThan(0)) {
        await postJournalEntry(tx, schoolId, {
          sourceType: "INVOICE",
          sourceId: invoice.id,
          memo: `Invoice ${invoiceNo}`,
          actorUserId,
          lines: [
            { accountId: core.receivableAccountId, debit: mappedTotal },
            ...[...creditByAccount.entries()].map(([accountId, credit]) => ({ accountId, credit })),
          ],
        });
      }
    }

    // Generating an EARLIER term after later ones exist must still re-link them.
    await syncCarriedForward(tx, student.id);

    result.created += 1;
  }

  return result;
}

