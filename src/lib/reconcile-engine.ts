import { Prisma } from "@prisma/client";

export type StatementRow = {
  paidAt: Date;
  amount: Prisma.Decimal;
  reference: string | null;
  narration: string | null;
};

export type BookPayment = {
  id: string;
  receiptNo: string;
  paidAt: Date;
  amount: Prisma.Decimal | number | string;
  reference: string | null;
};

export type Match = {
  row: StatementRow;
  payment: BookPayment | null;
  how: "reference" | "amount+date" | null;
};

/** A reference as the two sides will never quite agree on it. */
export function normaliseRef(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parse a pasted bank or momo statement.
 *
 * Deliberately forgiving about columns and strict about the amount. Every
 * Ghanaian bank exports a different CSV — GCB, Fidelity, Stanbic and an MTN
 * MoMo statement share no header row — so this takes date, amount and a free
 * text reference in whatever order the header names them, and refuses a line
 * whose amount is not a number rather than silently reconciling a zero.
 *
 * Credits only: a statement carries the school's own outgoings too, and matching
 * a debit against a receipt would reconcile money leaving the account with money
 * arriving in the book.
 */
export function parseStatement(text: string): { rows: StatementRow[]; skipped: string[] } {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows: StatementRow[] = [];
  const skipped: string[] = [];
  if (lines.length === 0) return { rows, skipped };

  const split = (line: string) =>
    line.split(/\t|,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map((cell) => cell.trim().replace(/^"|"$/g, ""));

  const header = split(lines[0]).map((cell) => cell.toLowerCase());
  const looksLikeHeader = header.some((cell) => /date|amount|credit|ref|narrat|descri/.test(cell));
  const find = (...names: string[]) => header.findIndex((cell) => names.some((n) => cell.includes(n)));

  const dateAt = looksLikeHeader ? find("date", "time") : 0;
  const amountAt = looksLikeHeader ? find("credit", "amount", "paid in") : 1;
  const refAt = looksLikeHeader ? find("ref", "transaction id", "txn") : 2;
  const narrAt = looksLikeHeader ? find("narrat", "descri", "details", "particular") : 3;

  for (const line of lines.slice(looksLikeHeader ? 1 : 0)) {
    const cells = split(line);
    const rawDate = cells[dateAt >= 0 ? dateAt : 0] ?? "";
    const rawAmount = (cells[amountAt >= 0 ? amountAt : 1] ?? "").replace(/[^\d.-]/g, "");
    const when = parseDate(rawDate);
    const amount = Number(rawAmount);

    if (!when || !Number.isFinite(amount) || amount <= 0) {
      skipped.push(line.slice(0, 80));
      continue;
    }
    rows.push({
      paidAt: when,
      amount: new Prisma.Decimal(amount.toFixed(2)),
      reference: (refAt >= 0 ? cells[refAt] : null) || null,
      narration: (narrAt >= 0 ? cells[narrAt] : null) || null,
    });
  }
  return { rows, skipped };
}

/**
 * ⚠️ Day first.
 *
 * "05/06/2026" is the 5th of June to every bank in Ghana and to Date.parse it is
 * the 6th of May. Getting this backwards does not fail — it shifts a line by a
 * month and quietly drops it out of the matching window, so the reconciliation
 * reports money missing that is sitting right there.
 */
function parseDate(raw: string): Date | null {
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (dmy) {
    const [, d, m, y] = dmy;
    const year = Number(y.length === 2 ? `20${y}` : y);
    const date = new Date(year, Number(m) - 1, Number(d));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = new Date(raw);
  return Number.isNaN(iso.getTime()) ? null : iso;
}

/**
 * Match statement lines against payments in the book.
 *
 * Reference first, amount-and-date second, and nothing else. A looser rule —
 * nearest amount, say — would pair two ₵500 fees paid the same morning with
 * each other's slips, and a reconciliation that is confidently wrong is worse
 * than one that reports two unmatched lines for a human to look at.
 *
 * Each payment is claimed at most once: two identical transfers must match two
 * separate receipts, not the same one twice.
 */
export function matchStatement(
  rows: StatementRow[],
  payments: BookPayment[],
  windowDays = 3,
): { matches: Match[]; unmatchedPayments: BookPayment[] } {
  const claimed = new Set<string>();
  const byRef = new Map<string, BookPayment[]>();
  for (const payment of payments) {
    const key = normaliseRef(payment.reference);
    if (!key) continue;
    byRef.set(key, [...(byRef.get(key) ?? []), payment]);
  }

  const matches: Match[] = rows.map((row) => {
    const key = normaliseRef(row.reference);
    if (key) {
      const candidate = (byRef.get(key) ?? []).find((p) => !claimed.has(p.id));
      if (candidate) {
        claimed.add(candidate.id);
        return { row, payment: candidate, how: "reference" };
      }
    }

    const window = windowDays * 86_400_000;
    const candidate = payments.find(
      (p) =>
        !claimed.has(p.id) &&
        Math.abs(Number(p.amount) - Number(row.amount)) < 0.005 &&
        Math.abs(p.paidAt.getTime() - row.paidAt.getTime()) <= window,
    );
    if (candidate) {
      claimed.add(candidate.id);
      return { row, payment: candidate, how: "amount+date" };
    }
    return { row, payment: null, how: null };
  });

  return { matches, unmatchedPayments: payments.filter((p) => !claimed.has(p.id)) };
}
