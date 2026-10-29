import "server-only";

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { key as masterKey } from "@/lib/totp-crypto";

/**
 * A school's Paystack secret key, encrypted before it reaches the database.
 *
 * Like the authenticator secret, the server must be able to READ IT BACK (it signs nothing, but
 * it authenticates every call to Paystack and checks every webhook's signature), so it cannot be
 * hashed. A dump or backup of the database must not hand over the keys to every school's
 * Paystack account, so it is AES-256-GCM under a key that lives only in the deployment.
 *
 * The key is DERIVED from `TOTP_ENCRYPTION_KEY` (HKDF, with a purpose label) rather than being a
 * second variable to provision on every deployment. The label means this subkey is not the one the
 * authenticator secrets use: a ciphertext from one place does not decrypt in the other, and
 * neither can be swapped for the other. It fails closed, as the original does: with no master key,
 * saving or using a gateway throws instead of storing a key unprotected.
 *
 * ⚠️ Rotating `TOTP_ENCRYPTION_KEY` makes every stored Paystack key unreadable (the school pastes
 * it in again), exactly as it makes platform admins enrol again.
 */
const PURPOSE = "school-os:paystack-secret:v1";

function subkey(): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey(), Buffer.alloc(0), PURPOSE, 32));
}

export function encryptGatewaySecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", subkey(), iv);
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["g1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decryptGatewaySecret(stored: string): string {
  const [version, iv, tag, body] = stored.split(".");
  if (version !== "g1" || !iv || !tag || !body) {
    throw new Error("Unrecognised stored gateway secret");
  }
  const decipher = createDecipheriv("aes-256-gcm", subkey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}
