/**
 * Issue a platform admin's one-time enrolment code.
 *
 * The scripts that call this (`make:admin`, `reset-platform-2fa`, `platform`) are run by hand, by
 * whoever holds database access, under plain `node` or `tsx`. This is the ISSUING half; the app's
 * CHECKING half is `src/lib/enrolment-code.ts`. They are separate implementations because the
 * `.mjs` scripts cannot import TypeScript, and `verify:enrolment-code` proves that a code issued
 * here is accepted there and a different one is not, so the two cannot drift apart unnoticed.
 *
 * ⚠️ The code protects the step AFTER the password, so it is only worth anything if it reaches the
 * admin by a different route from the password. These scripts print both, on one screen, and say so.
 */
import { createHash, randomBytes } from "node:crypto";

/** How long a code stays good. Long enough to be sent and used across a day; short enough to expire. */
export const ENROLMENT_CODE_HOURS = 48;

// 31 symbols, with no 0, O, 1, I or L, because the code is read aloud and typed from a phone.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

function randomSymbol() {
  // Rejection sampling, so every symbol is equally likely: 248 is the largest multiple of 31 that
  // fits in a byte, and a byte at or above it is thrown away rather than folded in with `%`.
  for (;;) {
    const [byte] = randomBytes(1);
    if (byte < 248) {
      return ALPHABET[byte % ALPHABET.length];
    }
  }
}

const normalise = (raw) => raw.toUpperCase().replace(/[^A-Z0-9]/g, "");

export const hashCode = (raw) =>
  createHash("sha256").update(`platform-enrolment:${normalise(raw)}`).digest("hex");

/** A new code: what to show the admin, what to store, and when it lapses. About 59 bits. */
export function newEnrolmentCode(now = Date.now()) {
  const symbols = Array.from({ length: LENGTH }, randomSymbol).join("");
  const code = `${symbols.slice(0, 4)}-${symbols.slice(4, 8)}-${symbols.slice(8)}`;
  return { code, hash: hashCode(code), expiresAt: new Date(now + ENROLMENT_CODE_HOURS * 3600_000) };
}

/** The words every script prints under a new code, so the warning is said once and the same way. */
export function enrolmentCodeNotice(issued) {
  return [
    `Enrolment code:     ${issued.code}`,
    `  Valid until ${issued.expiresAt.toISOString().replace("T", " ").slice(0, 16)} UTC, and for one enrolment.`,
    "  Send it by a DIFFERENT route from the password (the password by message, this by phone, or the",
    "  other way round). The password alone can no longer set up the console; if both travel together,",
    "  whoever sees one sees both and the code protects nothing.",
  ].join("\n");
}
