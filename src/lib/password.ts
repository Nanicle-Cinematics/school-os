import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

export type ScryptParams = { N: number; r: number; p: number };

const scrypt = promisify(scryptCb) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptParams & { maxmem: number },
) => Promise<Buffer>;

const KEYLEN = 64;

/**
 * Node refuses any scrypt that needs more than 32 MiB unless told otherwise, and the cost we are
 * moving to needs 64. Passed on every call, which also caps what a stored hash can ask for: a
 * row claiming absurd parameters is refused, not allowed to allocate its way to a crash.
 */
const MAXMEM = 256 * 1024 * 1024;

/**
 * What every hash written before 2026-10-12 used: Node's own defaults, which are below current
 * OWASP guidance (N=2^17, or an equivalent trade such as N=2^16 with p=2).
 */
export const LEGACY_PARAMS: ScryptParams = { N: 2 ** 14, r: 8, p: 1 };

/**
 * The cost new hashes are meant to carry: OWASP's N=2^16, r=8, p=2, about 64 MiB. Chosen over
 * N=2^17 (128 MiB) because this runs on serverless instances that hold several sign-ins at once,
 * and the three equal-strength options OWASP lists trade memory for CPU, not strength for speed.
 *
 * ⚠️ NOT WRITTEN YET. `hashPassword` still produces LEGACY_PARAMS. This change only teaches
 * `verifyPassword` to READ the new format, so that code reading it is live everywhere before any
 * hash in it exists: a deploy overlap, or a rollback, would otherwise lock out every user whose
 * hash had already been upgraded. The next change flips `WRITE_PARAMS` and upgrades hashes at
 * sign-in.
 */
export const CURRENT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 2 };

/** What `hashPassword` writes. See CURRENT_PARAMS for why this is still the legacy cost. */
const WRITE_PARAMS: ScryptParams = LEGACY_PARAMS;

/** The one place that calls scrypt, exported so a test can check it against the RFC 7914 vectors. */
export function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scrypt(password, salt, KEYLEN, { ...params, maxmem: MAXMEM });
}

/**
 * Two formats, told apart by how many `$`-separated fields they have:
 *
 *   legacy   scrypt$<salt hex>$<hash hex>                    (LEGACY_PARAMS, implied)
 *   current  scrypt$ln=16,r=8,p=2$<salt hex>$<hash hex>      (parameters travel with the hash)
 *
 * Carrying the parameters is what makes the next upgrade a rehash at sign-in instead of another
 * format change. `ln` is log2(N), as in PHC strings.
 */
function formatHash(params: ScryptParams, salt: Buffer, hash: Buffer) {
  const same = params.N === LEGACY_PARAMS.N && params.r === LEGACY_PARAMS.r && params.p === LEGACY_PARAMS.p;
  return same
    ? `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`
    : `scrypt$ln=${Math.log2(params.N)},r=${params.r},p=${params.p}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/**
 * The parameters a stored hash declares, or null if they are not ones we would run. Bounded on
 * purpose: the value comes from the database, and "refuse" is a better answer to a corrupt row
 * than allocating whatever it asks for.
 */
function parseParams(field: string): ScryptParams | null {
  const match = /^ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2})$/.exec(field);
  if (!match) {
    return null;
  }
  const [ln, r, p] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (ln < 14 || ln > 18 || r !== 8 || p < 1 || p > 8) {
    return null;
  }
  // Each bound alone still lets through a combination that is several seconds of CPU per sign-in
  // (ln=17 with p=8 is eight times the intended work). Cap the product too: 2^18 allows every
  // OWASP-listed equivalent — 2^17×1, 2^16×2, 2^15×3, 2^14×5 — and nothing heavier.
  if (2 ** ln * p > 2 ** 18) {
    return null;
  }
  return { N: 2 ** ln, r, p };
}

function parseStored(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt" || (parts.length !== 3 && parts.length !== 4)) {
    return null;
  }
  const params = parts.length === 3 ? LEGACY_PARAMS : parseParams(parts[1]);
  const saltHex = parts[parts.length - 2];
  const hashHex = parts[parts.length - 1];
  if (!params || !saltHex || !hashHex) {
    return null;
  }
  return { params, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

/** Hash at an explicit cost. `hashPassword` is this at WRITE_PARAMS; tests use it for either. */
export async function hashPasswordWith(password: string, params: ScryptParams): Promise<string> {
  const salt = randomBytes(16);
  return formatHash(params, salt, await deriveKey(password, salt, params));
}

// scrypt from node:crypto rather than bcrypt/argon2 — no native module to build,
// which matters on a machine without Xcode command line tools.
export async function hashPassword(password: string): Promise<string> {
  return hashPasswordWith(password, WRITE_PARAMS);
}

/** Verifies a hash in either format, at the cost it declares. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await deriveKey(password, parsed.salt, parsed.params);
  } catch {
    // Parameters Node will not run (memory over the cap). A corrupt row is a failed sign-in.
    return false;
  }
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
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
 * The longest `temporaryPassword` can be: the two longest words, two four-digit groups and the
 * "!". For anything that has to budget for the worst case — an SMS cost estimate must never
 * come in under what is actually sent.
 */
const WORD_LENGTHS = TEMP_PASSWORD_WORDS.map((word) => word.length).sort((a, b) => b - a);
export const TEMP_PASSWORD_MAX_LENGTH = WORD_LENGTHS[0] + WORD_LENGTHS[1] + 4 + 4 + 1;

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
