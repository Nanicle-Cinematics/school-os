import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238) and the base32 an authenticator app is
 * given (RFC 4648). No dependency: HMAC-SHA1, 30-second steps, six digits — the
 * parameters every authenticator app assumes.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
export const DIGITS = 6;
/** Steps either side of "now" that still count, for a phone clock a little out. */
const WINDOW = 1;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error("Not a base32 string");
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits — the size RFC 4226 recommends for an HMAC-SHA1 secret. */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

export function stepFor(nowMs: number): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

/** The code for one step. */
export function codeAt(secret: Uint8Array, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The step a submitted code belongs to, or null if it matches none.
 *
 * `lastUsedStep` is the newest step already spent. A code is accepted only for a
 * step AFTER it, so one that was shoulder-surfed or intercepted cannot be replayed
 * inside its 30-90 seconds of validity.
 */
export function verifyTotp(
  secret: Uint8Array,
  submitted: string,
  nowMs: number,
  lastUsedStep: number | null,
): number | null {
  const code = submitted.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const current = stepFor(nowMs);
  let matched: number | null = null;
  // Check every step in the window (no early exit) so timing says nothing about which.
  for (let step = current - WINDOW; step <= current + WINDOW; step += 1) {
    const expected = Buffer.from(codeAt(secret, step));
    const given = Buffer.from(code);
    if (timingSafeEqual(expected, given) && (lastUsedStep === null || step > lastUsedStep)) {
      matched = step;
    }
  }
  return matched;
}

/** The URI an authenticator app reads from a QR code. */
export function otpauthUri(secret: Uint8Array, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
