"use server";

import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { setTenantContext } from "@/lib/tenant-context";
import { FINANCE } from "@/lib/permissions";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { matchStatement, parseStatement } from "@/lib/reconcile-engine";
import { writeAudit } from "@/lib/audit";

export type ReconcileState = {
  error?: string;
  ok?: string;
  report?: {
    matched: number;
    unmatchedLines: { paidAt: string; amount: string; reference: string | null; narration: string | null }[];
    unmatchedPayments: { receiptNo: string; paidAt: string; amount: string }[];
    skipped: string[];
  };
};

/**
 * Reconcile a pasted statement against the book.
 *
 * ⚠️ CASH is excluded from both sides. Cash across the counter never appears on
 * a bank statement, so including it would report every cash receipt as "in the
 * book, not in the account" — a list so long nobody reads the real findings in
 * it. Reconciliation is about money that travelled.
 *
 * The matched lines are STORED, unmatched ones too, because the useful half of
 * a reconciliation is what did not match: money in the account the book has no
 * record of is the finding a bursar has to explain.
 */
export async function reconcileStatement(
  _prev: ReconcileState,
  formData: FormData,
): Promise<ReconcileState> {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const text = String(formData.get("statement") ?? "").trim();
  if (!text) {
    return { error: "Paste the statement lines first." };
  }

  const { rows, skipped } = parseStatement(text);
  if (rows.length === 0) {
    return {
      error:
        "No usable lines. Each needs a date and a credit amount — paste the rows from the bank's CSV, header included.",
    };
  }

  const earliest = new Date(Math.min(...rows.map((r) => r.paidAt.getTime())) - 7 * 86_400_000);
  const latest = new Date(Math.max(...rows.map((r) => r.paidAt.getTime())) + 7 * 86_400_000);

  const payments = await prisma.payment.findMany({
    where: {
      status: "CONFIRMED",
      method: { not: "CASH" },
      paidAt: { gte: earliest, lte: latest },
      statementLine: null,
    },
    select: { id: true, receiptNo: true, paidAt: true, amount: true, reference: true },
    orderBy: { paidAt: "asc" },
  });

  const { matches, unmatchedPayments } = matchStatement(rows, payments);

  await tenantTransaction(auth.schoolId, async (tx) => {
    for (const match of matches) {
      await tx.statementLine.create({
        data: {
          schoolId: auth.schoolId,
          paidAt: match.row.paidAt,
          amount: match.row.amount,
          reference: match.row.reference,
          narration: match.row.narration,
          paymentId: match.payment?.id ?? null,
          importedByUserId: auth.userId,
        },
      });
    }

    await writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "statement.reconcile",
      entity: "StatementLine",
      entityId: auth.schoolId,
      after: {
        lines: rows.length,
        matched: matches.filter((m) => m.payment).length,
        unmatched: matches.filter((m) => !m.payment).length,
      },
    });
  });

  const money = (value: unknown) => String(value);
  const day = (value: Date) => value.toISOString().slice(0, 10);

  revalidatePath("/payments/reconcile");
  return {
    ok: `${matches.filter((m) => m.payment).length} of ${rows.length} lines matched.`,
    report: {
      matched: matches.filter((m) => m.payment).length,
      unmatchedLines: matches
        .filter((m) => !m.payment)
        .map((m) => ({
          paidAt: day(m.row.paidAt),
          amount: money(m.row.amount),
          reference: m.row.reference,
          narration: m.row.narration,
        })),
      unmatchedPayments: unmatchedPayments.map((p) => ({
        receiptNo: p.receiptNo,
        paidAt: day(p.paidAt),
        amount: money(p.amount),
      })),
      skipped,
    },
  };
}
