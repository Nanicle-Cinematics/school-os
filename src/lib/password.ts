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

const WORDS = ["Kente", "Adinkra", "Sankofa", "Bosom", "Akoma", "Gyata", "Odum", "Fufu"];

/**
 * A temporary password the office can read aloud over the phone.
 *
 * Word plus digits rather than random characters: it gets dictated to a teacher
 * who then types it on a phone keyboard, and an unreadable string just becomes a
 * sticky note on the bursar's monitor.
 */
export function temporaryPassword() {
  return `${WORDS[randomInt(WORDS.length)]}${randomInt(1000, 10000)}!`;
}
