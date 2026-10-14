import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The one-time code a platform admin must present before they may attach their first authenticator.
 *
 * ⚠️ Why it exists. The console is protected by a password AND an authenticator code, but until an
 * admin has enrolled an authenticator the password alone reaches the setup page, and whoever holds
 * the password first can attach an authenticator of their own: that opens the console and locks the
 * real admin out. The password is the thing that gets seen (`make:admin` prints it to a terminal,
 * and so to a scrollback buffer and possibly a screenshot), so it cannot also be what guards the
 * step that follows. This code is the second thing, and is only worth anything if it reaches the
 * admin by a DIFFERENT route from the password.
 *
 * Issued by whoever has database access (the scripts), never by the app: a screen that could mint
 * one would be a way around it, exactly as for the second factor itself. Only a hash is stored.
 *
 * Pure: `node:crypto` and nothing else, so a verify script can exercise it without a database.
 * `scripts/enrolment-code.mjs` ISSUES codes and cannot import this file (the scripts that use it
 * run under plain `node`), so the two are separate implementations that `verify:enrolment-code`
 * proves agree.
 */

/** Written XXXX-XXXX-XXXX; the hash is of the normalised form, so dashes and case do not matter. */
export function normalizeEnrolmentCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Domain-separated, so a recovery code or session token can never double as an enrolment code. */
export function hashEnrolmentCode(raw: string): string {
  return createHash("sha256").update(`platform-enrolment:${normalizeEnrolmentCode(raw)}`).digest("hex");
}

/**
 * Is `submitted` the code on record, and is it still current?
 *
 * False when no code was issued (null hash), when it has expired, or when it differs. The comparison
 * is constant-time, and the answer is one boolean: the caller must not say WHICH of those it was.
 */
export function enrolmentCodeAccepted(
  submitted: string,
  stored: { hash: string | null; expiresAt: Date | null },
  now: Date = new Date(),
): boolean {
  if (!stored.hash || !stored.expiresAt || stored.expiresAt.getTime() <= now.getTime()) {
    return false;
  }
  if (normalizeEnrolmentCode(submitted).length === 0) {
    return false;
  }
  const a = Buffer.from(hashEnrolmentCode(submitted), "hex");
  const b = Buffer.from(stored.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
