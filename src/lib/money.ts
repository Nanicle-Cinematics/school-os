import { Prisma } from "@prisma/client";

export type Money = Prisma.Decimal;

const formatter = new Intl.NumberFormat("en-GH", {
  style: "currency",
  currency: "GHS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const compact = new Intl.NumberFormat("en-GH", {
  style: "currency",
  currency: "GHS",
  maximumFractionDigits: 0,
});

/** Money is stored as Decimal(12,2); never let a float near it. */
export function money(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

export function formatCedis(value: Prisma.Decimal | number | string | null | undefined) {
  if (value === null || value === undefined) {
    return formatter.format(0);
  }
  return formatter.format(Number(value));
}

/** For stat tiles, where the pesewas are noise. */
export function formatCedisCompact(value: Prisma.Decimal | number | string | null | undefined) {
  return compact.format(Number(value ?? 0));
}

/**
 * Parse a user-entered amount. Accepts "1,250.50" and "GHS 1250".
 * Returns null when the input isn't a positive number, so callers can show a
 * field error rather than writing a NaN into the ledger.
 */
export function parseAmount(input: FormDataEntryValue | null): Prisma.Decimal | null {
  const raw = String(input ?? "").replace(/[^\d.-]/g, "");
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return new Prisma.Decimal(parsed.toFixed(2));
}

export function sum(values: (Prisma.Decimal | number | string)[]): Prisma.Decimal {
  return values.reduce<Prisma.Decimal>(
    (total, value) => total.add(new Prisma.Decimal(value)),
    new Prisma.Decimal(0),
  );
}
