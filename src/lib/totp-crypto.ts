import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * The authenticator secret is encrypted before it reaches the database.
 *
 * A TOTP secret is a password the server must be able to READ BACK, so it cannot be
 * hashed. Stored in the clear, a leaked database dump or backup would hand over
 * every platform admin's second factor along with their password hash — the exact
 * pair the second factor exists to keep apart. AES-256-GCM under a key that lives
 * only in the deployment's environment (TOTP_ENCRYPTION_KEY, 32 random bytes,
 * base64) means the database alone is not enough.
 *
 * Fails CLOSED: with no key, enrolling or verifying throws rather than quietly
 * storing a secret unprotected.
 */
export function key(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "TOTP_ENCRYPTION_KEY is not set, so two-factor sign-in cannot work. Generate one with " +
        "`openssl rand -base64 32` and add it to the deployment's environment.",
    );
  }
  const bytes = Buffer.from(raw, "base64");
  if (bytes.length !== 32) {
    throw new Error("TOTP_ENCRYPTION_KEY must be 32 bytes, base64-encoded (`openssl rand -base64 32`).");
  }
  return bytes;
}

export function encryptSecret(secret: Uint8Array): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptSecret(stored: string): Buffer {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "v1" || !iv || !tag || !body) {
    throw new Error("Unrecognised stored secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]);
}

/** Recovery codes are random and high-entropy, so a fast hash is enough to store them. */
export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.replace(/[\s-]/g, "").toUpperCase()).digest("hex");
}

/** Whether the key is present and well-formed, so a page can say so instead of crashing. */
export function encryptionKeyProblem(): string | null {
  try {
    key();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "TOTP_ENCRYPTION_KEY is not usable.";
  }
}
