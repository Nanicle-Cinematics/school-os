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
 * ⚠️ Raised in two steps, in this order, and the order is the point. A hash in this format is
 * unreadable to code that predates the code that reads it, so reading shipped first (2026-10-12,
 * #169) and was live everywhere before anything wrote it: written any sooner, a deploy overlap or a
 * rollback would lock out every user already upgraded. If you ever raise the cost again, do it the
 * same way — teach `parseParams` the new bounds, ship it, THEN change this constant.
 */
export const CURRENT_PARAMS: ScryptParams = { N: 2 ** 16, r: 8, p: 2 };

/**
 * What `hashPassword` writes. Rolling this BACK is safe (the code reads either format); rolling the
 * CODE back past #169 is not, once hashes in the new format exist.
 */
const WRITE_PARAMS: ScryptParams = CURRENT_PARAMS;

/** The one place that calls scrypt, exported so a test can check it against the RFC 7914 vectors. */
export function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return scrypt(password, salt, KEYLEN, { ...params, maxmem: MAXMEM });
}

/**
 * Every derivation in this file goes through `engine.derive`, looked up at the moment of the call,
 * so a test can stand a counter in its place and see exactly what a sign-in computed. Nothing else
 * replaces it: it is how "every failed attempt costs the same" is checked by what was run, not
 * by how long it took, which a loaded CI machine would make a coin flip.
 */
export const engine = { derive: deriveKey };

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

const sameCost = (a: ScryptParams, b: ScryptParams) => a.N === b.N && a.r === b.r && a.p === b.p;

/** Verifies a hash in either format, at the cost it declares. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseStored(stored);
  if (!parsed) {
    return false;
  }
  let derived: Buffer;
  try {
    derived = await engine.derive(password, parsed.salt, parsed.params);
  } catch {
    // Parameters Node will not run (memory over the cap). A corrupt row is a failed sign-in.
    return false;
  }
  return derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
}

/** Whether a stored hash was made at a cost other than the current one, and so wants rewriting. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStored(stored);
  return parsed !== null && !sameCost(parsed.params, CURRENT_PARAMS);
}

/** A salt no real hash has, for the work done on behalf of an account that does not exist. */
const DUMMY_SALT = Buffer.alloc(16);

/**
 * The sign-in check: is this the password, and if so, is there a stronger hash to store?
 *
 * ⚠️ EVERY FAILED ATTEMPT COSTS THE SAME, whoever it is for: one derivation at the legacy cost and
 * one at the current cost.
 *
 *   an account that does not exist   current (against a dummy hash), then legacy
 *   a legacy hash, wrong password    legacy (the check), then current
 *   a current hash, wrong password   current (the check), then legacy
 *
 * Login has always verified against a dummy hash for an unknown account so that the time taken
 * does not say which accounts exist. With two costs in the database that stopped being enough: a
 * legacy hash is roughly eight times quicker to check than a current one, so a bare check would
 * let anyone time a wrong guess and tell the accounts that have not signed in since the upgrade
 * (fast, so they exist) from the rest. Topping every failure up to the same pair closes it.
 *
 * A CORRECT password costs what it costs: it signs the person in, so there is nothing to hide.
 * For a legacy hash that is the check plus the new hash, which is also the upgrade — computed once,
 * not twice. A current hash that is right needs nothing more.
 */
export async function checkPassword(
  password: string,
  stored: string | null | undefined,
): Promise<{ ok: boolean; rehash: string | null }> {
  const parsed = stored ? parseStored(stored) : null;

  let ok = false;
  let spent: ScryptParams;
  if (parsed) {
    spent = parsed.params;
    try {
      const derived = await engine.derive(password, parsed.salt, parsed.params);
      ok = derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash);
    } catch {
      ok = false;
    }
  } else {
    // No such account, no password set, or a row we cannot read: spend the current cost on nothing.
    spent = CURRENT_PARAMS;
    try {
      await engine.derive(password, DUMMY_SALT, CURRENT_PARAMS);
    } catch {
      // Nothing to report: the answer is already "no".
    }
  }

  if (!sameCost(spent, CURRENT_PARAMS)) {
    // The hash is at some other cost (the legacy one, in practice): pay the current cost now. If the
    // password was right, this is the upgrade; if not, it is the top-up that keeps this attempt
    // looking like every other.
    const salt = randomBytes(16);
    const hash = await engine.derive(password, salt, CURRENT_PARAMS);
    return { ok, rehash: ok ? formatHash(CURRENT_PARAMS, salt, hash) : null };
  }
  if (!ok) {
    // Already at the current cost and wrong (or no such account): top up with the legacy cost.
    await engine.derive(password, DUMMY_SALT, LEGACY_PARAMS);
  }
  return { ok, rehash: null };
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
