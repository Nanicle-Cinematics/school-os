import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { Prisma } from "@prisma/client";

/**
 * Paystack, as little of it as School OS needs: start a checkout, ask what happened to a
 * transaction, and check that a webhook really came from Paystack.
 *
 * No Prisma and no database in this file, and `fetch` is passed in, so `verify:paystack` can run
 * every rule here (the signature, the pesewas arithmetic, what counts as a payment we may book)
 * with no server and no network.
 *
 * Money is held by Paystack in the smallest unit, pesewas, as an integer. We convert exactly with
 * `Prisma.Decimal` and never through a floating-point number: 0.1 + 0.2 pesewas is not a thing a
 * bursar can explain.
 */

export const PAYSTACK_API = "https://api.paystack.co";
const TIMEOUT_MS = 15_000;

type Fetch = typeof fetch;

/** `sk_test_…` or `sk_live_…`. A public key (`pk_…`) is refused: pasting the wrong one is the usual slip. */
export function parseSecretKey(raw: string): { ok: true; key: string; mode: "test" | "live" } | { ok: false; error: string } {
  const key = raw.trim();
  if (/^pk_(test|live)_/.test(key)) {
    return { ok: false, error: "That is the public key. Paste the SECRET key, which starts with sk_." };
  }
  const match = /^sk_(test|live)_[A-Za-z0-9]{16,128}$/.exec(key);
  if (!match) {
    return { ok: false, error: "That does not look like a Paystack secret key. It starts with sk_test_ or sk_live_." };
  }
  return { ok: true, key, mode: match[1] as "test" | "live" };
}

/** GHS to pesewas, exactly. Refuses anything that is not a whole number of pesewas above zero. */
export function toPesewas(amount: Prisma.Decimal | string | number): number | null {
  const value = new Prisma.Decimal(amount);
  const pesewas = value.mul(100);
  if (!pesewas.isInteger() || pesewas.lte(0) || pesewas.gt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return pesewas.toNumber();
}

/** A reference nobody can guess and that fits Paystack's rules (letters, digits, `-`, `.`, `=`). */
export function newReference(random: Uint8Array): string {
  return "SOS-" + Buffer.from(random).toString("hex").toUpperCase();
}

/**
 * Whether `signature` is the HMAC-SHA512 of the RAW request body under the school's secret key.
 * Constant time, and false (never a throw) for anything malformed.
 */
export function signatureMatches(rawBody: string, signature: string | null, secretKey: string): boolean {
  if (!signature || !/^[0-9a-f]{128}$/i.test(signature)) {
    return false;
  }
  const expected = createHmac("sha512", secretKey).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Only the shape of a signature, cheap enough to check BEFORE any database lookup. */
export const looksLikeSignature = (value: string | null): value is string =>
  typeof value === "string" && /^[0-9a-f]{128}$/i.test(value);

export type VerifiedTransaction = {
  reference: string;
  amountPesewas: number;
  currency: string;
  channel: string | null;
  /** MoMo network when Paystack names one ("MTN", "Telecel"...); null for a card. */
  network: "MTN" | "TELECEL" | "AIRTELTIGO" | null;
};

export type VerifyResult =
  | { state: "success"; transaction: VerifiedTransaction }
  | { state: "pending" }
  | { state: "failed"; reason: string }
  | { state: "error"; reason: string };

/** What Paystack calls the network, in the three names the ledger knows. */
export function momoNetwork(...hints: Array<string | null | undefined>): VerifiedTransaction["network"] {
  const text = hints.filter(Boolean).join(" ").toLowerCase();
  if (/mtn/.test(text)) return "MTN";
  if (/telecel|vodafone/.test(text)) return "TELECEL";
  if (/airtel|tigo/.test(text)) return "AIRTELTIGO";
  return null;
}

async function call(fetchImpl: Fetch, secretKey: string, path: string, init?: RequestInit) {
  const res = await fetchImpl(`${PAYSTACK_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secretKey}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cache: "no-store",
  });
  // Read as text first: an error page from a proxy is HTML and `res.json()` would throw on it.
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body: body as Record<string, unknown> | null };
}

/** Whether the key opens a Paystack account. A cheap read, with no side effects. */
export async function testKey(secretKey: string, fetchImpl: Fetch = fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const { status, body } = await call(fetchImpl, secretKey, "/balance");
    if (status === 200 && body?.status === true) return { ok: true };
    const message = typeof body?.message === "string" ? body.message : `HTTP ${status}`;
    return { ok: false, error: status === 401 ? "Paystack did not accept that key." : `Paystack answered: ${message}` };
  } catch {
    return { ok: false, error: "Could not reach Paystack. Check the connection and try again." };
  }
}

export type InitializeInput = {
  email: string;
  amountPesewas: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, string>;
};

export async function initializeTransaction(
  secretKey: string,
  input: InitializeInput,
  fetchImpl: Fetch = fetch,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const { status, body } = await call(fetchImpl, secretKey, "/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: input.email,
        amount: input.amountPesewas,
        currency: "GHS",
        reference: input.reference,
        callback_url: input.callbackUrl,
        channels: ["mobile_money", "card"],
        metadata: input.metadata,
      }),
    });
    const data = body?.data as Record<string, unknown> | undefined;
    if (status === 200 && body?.status === true && typeof data?.authorization_url === "string") {
      return { ok: true, url: data.authorization_url };
    }
    return { ok: false, error: typeof body?.message === "string" ? body.message : `HTTP ${status}` };
  } catch {
    return { ok: false, error: "Could not reach Paystack." };
  }
}

/** Ask Paystack, with the school's own key, what became of a transaction. The only source of truth. */
export async function verifyTransaction(
  secretKey: string,
  reference: string,
  fetchImpl: Fetch = fetch,
): Promise<VerifyResult> {
  try {
    const { status, body } = await call(fetchImpl, secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
    if (status === 404) return { state: "pending" };
    if (status !== 200 || body?.status !== true) {
      return { state: "error", reason: typeof body?.message === "string" ? body.message : `HTTP ${status}` };
    }
    const data = body.data as Record<string, unknown> | undefined;
    const outcome = data?.status;
    if (outcome === "success") {
      const authorization = (data?.authorization ?? {}) as Record<string, unknown>;
      if (
        typeof data?.reference !== "string" ||
        typeof data.amount !== "number" ||
        !Number.isInteger(data.amount) ||
        typeof data.currency !== "string"
      ) {
        return { state: "error", reason: "Paystack's answer was missing the amount or reference." };
      }
      const channel = typeof data.channel === "string" ? data.channel : null;
      return {
        state: "success",
        transaction: {
          reference: data.reference,
          amountPesewas: data.amount,
          currency: data.currency,
          channel,
          network:
            channel === "mobile_money"
              ? momoNetwork(
                  typeof authorization.bank === "string" ? authorization.bank : null,
                  typeof authorization.brand === "string" ? authorization.brand : null,
                )
              : null,
        },
      };
    }
    if (outcome === "failed" || outcome === "reversed") {
      return { state: "failed", reason: String(outcome) };
    }
    // "abandoned" is what a transaction reads BEFORE the parent has paid (and after they close the page),
    // and "pending", "ongoing", "processing", "queued" mean MoMo is awaiting approval. None of these is
    // an outcome: the parent can still finish, so they are waiting, never failed.
    return { state: "pending" };
  } catch {
    return { state: "error", reason: "Could not reach Paystack." };
  }
}

/**
 * Whether a CONFIRMED transaction is the one we asked for. The amount is checked against OUR row,
 * never the amount the browser or the webhook body claims, and the currency must be cedis: a
 * mismatch is not booked, it is kept for a person to look at.
 */
export function transactionMatches(
  expected: { reference: string; amount: Prisma.Decimal | string },
  actual: VerifiedTransaction,
): { ok: true } | { ok: false; reason: string } {
  if (actual.reference !== expected.reference) return { ok: false, reason: "Paystack answered for a different reference." };
  if (actual.currency !== "GHS") return { ok: false, reason: `Paid in ${actual.currency}, not cedis.` };
  const wanted = toPesewas(expected.amount);
  if (wanted === null || wanted !== actual.amountPesewas) {
    return { ok: false, reason: `Paid ${actual.amountPesewas} pesewas, expected ${wanted ?? "an invalid amount"}.` };
  }
  return { ok: true };
}
