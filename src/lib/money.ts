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

const ONES = [
  "", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function underThousand(n: number): string {
  if (n < 20) return ONES[n];
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)];
    const rest = n % 10;
    return rest ? `${tens}-${ONES[rest]}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} and ${underThousand(rest)}` : hundreds;
}

/**
 * The amount written out, for a receipt.
 *
 * Not decoration. A handwritten Ghanaian receipt carries the figure in words
 * precisely because a digit can be added to "500" after the fact and cannot be
 * added to "five hundred", and a parent disputing a payment months later is
 * holding the paper, not the database. A printed receipt that omits it reads as
 * less trustworthy than the carbon book it replaces.
 *
 * Pesewas are rendered as a fraction rather than words ("and 50/100"), which is
 * how the cheque convention this borrows from does it.
 */
export function cedisInWords(value: Prisma.Decimal | number | string): string {
  const amount = new Prisma.Decimal(value);
  const negative = amount.isNegative();
  const absolute = amount.abs();
  const whole = Math.floor(Number(absolute));
  const pesewas = Math.round((Number(absolute) - whole) * 100);

  const groups = [
    { size: 1_000_000_000, name: "billion" },
    { size: 1_000_000, name: "million" },
    { size: 1_000, name: "thousand" },
  ];

  let remaining = whole;
  const parts: string[] = [];
  for (const group of groups) {
    const count = Math.floor(remaining / group.size);
    if (count > 0) {
      parts.push(`${underThousand(count)} ${group.name}`);
      remaining -= count * group.size;
    }
  }
  if (remaining > 0) {
    // "and" before the last group only when there are thousands above it, which
    // is how the amount is read aloud: "one thousand AND fifty cedis".
    parts.push(parts.length > 0 && remaining < 100 ? `and ${underThousand(remaining)}` : underThousand(remaining));
  }

  const spoken = parts.length > 0 ? parts.join(" ") : "zero";
  const cedis = `${spoken} ${whole === 1 ? "cedi" : "cedis"}`;
  const tail = pesewas > 0 ? ` and ${pesewas}/100` : "";
  const words = `${cedis}${tail}`;
  return (negative ? `minus ${words}` : words).replace(/^./, (c) => c.toUpperCase());
}
