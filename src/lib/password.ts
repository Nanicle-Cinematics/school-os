import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

const KEYLEN = 64;

// scrypt from node:crypto rather than bcrypt/argon2 — no native module to build,
// which matters on a machine without Xcode command line tools.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt.toString("hex")}$${derived.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltHex, hashHex] = stored.split("$");
  if (algorithm !== "scrypt" || !saltHex || !hashHex) {
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const derived = await scrypt(password, Buffer.from(saltHex, "hex"), KEYLEN);
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Thirty-two, because the count is what the strength rests on — `TEMP_PASSWORD_SPACE` is
 * computed from it, and verify:password fails if the list ever shrinks enough to matter.
 * Short, easy to spell down a phone line, and no two alike.
 */
export const TEMP_PASSWORD_WORDS = [
  "Kente", "Adinkra", "Sankofa", "Bosom", "Akoma", "Gyata", "Odum", "Fufu",
  "Palm", "Cocoa", "Harmattan", "Baobab", "Mango", "Plantain", "Cassava", "Banku",
  "Jollof", "Savannah", "Volta", "Akosombo", "Kakum", "Ashanti", "Elmina", "Lagoon",
  "Sunrise", "Drumbeat", "Highlife", "Anansi", "Akwaaba", "Kumasi", "Tamale", "Accra",
] as const;

/** Four digits, 1000–9999: the same range for both groups. */
const GROUP_VALUES = 9000;

/**
 * How many different passwords `temporaryPassword` can produce: an ordered pair of
 * different words and two four-digit groups, about 8 × 10^10, which is 36 bits.
 */
export const TEMP_PASSWORD_SPACE =
  TEMP_PASSWORD_WORDS.length * (TEMP_PASSWORD_WORDS.length - 1) * GROUP_VALUES * GROUP_VALUES;

/**
 * A temporary password the office can read aloud over the phone: "Kente four-eight-two-nine,
 * Odum seven-three-one-six, exclamation mark".
 *
 * Words and digits rather than random characters: it gets dictated to a teacher who then
 * types it on a phone keyboard, and an unreadable string just becomes a sticky note on the
 * bursar's monitor.
 *
 * ⚠️ It used to be ONE word and ONE number — 72,000 possibilities, 16 bits — and that was
 * too few. The login lockout limits one address (40 tries per 15 minutes) and one account
 * (25), but it cannot stop an attacker who spreads the guesses: trying the SAME guess
 * against every account still on a temporary password costs one attempt per account, so
 * the account limit never trips, and a hit on SOME account takes about `space` attempts
 * whatever the number of accounts. A bulk parent invite leaves hundreds of such accounts for
 * up to 14 days; at 72,000, one address (40 attempts per 15 minutes, 3,840 a day) got there
 * in about three weeks and ten addresses in two days. At 36 bits the same attack needs
 * about 10^11 attempts: tens of thousands of years from one address.
 *
 * A stricter lockout for these accounts was considered and rejected: it would answer "too
 * many attempts" only for accounts that exist AND are still on a temporary password,
 * which tells an attacker exactly which logins are worth guessing at. Strength has to come
 * from the password, not from how it is refused.
 *
 * Passwords issued before this change keep the old strength until they are used or reach
 * the 14-day expiry; the office can issue a new one at any time.
 */
export function temporaryPassword() {
  const first = randomInt(TEMP_PASSWORD_WORDS.length);
  // The second word is drawn from the others, uniformly: pick among n − 1, then step over
  // the first. Two of the same word would also read as a typing mistake.
  let second = randomInt(TEMP_PASSWORD_WORDS.length - 1);
  if (second >= first) {
    second += 1;
  }
  return (
    `${TEMP_PASSWORD_WORDS[first]}${randomInt(1000, 10000)}` +
    `${TEMP_PASSWORD_WORDS[second]}${randomInt(1000, 10000)}!`
  );
}
