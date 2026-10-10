/**
 * Two-factor sign-in for the platform admin: the arithmetic and the encryption.
 *
 * The RFC 6238 appendix B vectors are the ground truth — if these match, a real
 * authenticator app's codes match too. No database.
 * Run: npm run verify:totp
 */
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

import { base32Decode, base32Encode, codeAt, generateSecret, otpauthUri, stepFor, verifyTotp } from "@/lib/totp";
import { decryptSecret, encryptSecret, hashRecoveryCode } from "@/lib/totp-crypto";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

console.log("RFC 6238 test vectors (SHA-1, secret 12345678901234567890, 8 digits → last 6)");
const rfc = Buffer.from("12345678901234567890");
for (const [t, eight] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"], [1234567890, "89005924"], [2000000000, "69279037"]] as const) {
  check(`t=${t}`, codeAt(rfc, stepFor(t * 1000)) === eight.slice(2), `got ${codeAt(rfc, stepFor(t * 1000))}`);
}

console.log("\nbase32");
check("RFC 4648 vector", base32Encode(Buffer.from("foobar")) === "MZXW6YTBOI");
check("round trip, any length", [1, 2, 3, 4, 5, 20].every((n) => { const b = generateSecret().subarray(0, n); return base32Decode(base32Encode(b)).equals(b); }));
check("lower case, spaces and dashes are tolerated", base32Decode("mzxw 6ytb-oi").toString() === "foobar");
check("junk is rejected", (() => { try { base32Decode("not!base32"); return false; } catch { return true; } })());

console.log("\nverifying a submitted code");
const secret = generateSecret();
const now = Date.parse("2026-10-03T10:00:00Z");
const step = stepFor(now);
check("the current code is accepted", verifyTotp(secret, codeAt(secret, step), now, null) === step);
check("a code from the previous step (clock a little behind) is accepted", verifyTotp(secret, codeAt(secret, step - 1), now, null) === step - 1);
check("a code from the next step (clock a little ahead) is accepted", verifyTotp(secret, codeAt(secret, step + 1), now, null) === step + 1);
check("a code two steps away is refused", verifyTotp(secret, codeAt(secret, step + 2), now, null) === null && verifyTotp(secret, codeAt(secret, step - 2), now, null) === null);
check("a wrong code is refused", verifyTotp(secret, codeAt(secret, step) === "000000" ? "000001" : "000000", now, null) === null);
check("spaces are ignored, letters and short codes refused", verifyTotp(secret, codeAt(secret, step).replace(/(...)(...)/, "$1 $2"), now, null) === step && verifyTotp(secret, "12345", now, null) === null && verifyTotp(secret, "abcdef", now, null) === null);
check("a spent step cannot be replayed", verifyTotp(secret, codeAt(secret, step), now, step) === null);
check("an OLDER step than the last used one is refused too", verifyTotp(secret, codeAt(secret, step - 1), now, step) === null);
check("the next step is still fine after one was spent", verifyTotp(secret, codeAt(secret, step + 1), now, step) === step + 1);
check("another secret's code does not match", verifyTotp(generateSecret(), codeAt(secret, step), now, null) === null);

console.log("\nthe QR payload");
const uri = otpauthUri(rfc, "owner@example.com", "School OS");
check("is a standard otpauth URI", uri.startsWith("otpauth://totp/School%20OS:owner%40example.com?") && uri.includes("secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ") && uri.includes("digits=6") && uri.includes("period=30"));

console.log("\nencryption at rest");
const sealed = encryptSecret(secret);
check("round trips", decryptSecret(sealed).equals(secret));
check("the stored text does not contain the secret", !sealed.includes(base32Encode(secret)) && !sealed.includes(secret.toString("base64url")));
check("two encryptions of one secret differ (random IV)", encryptSecret(secret) !== sealed);
// ⚠️ The first version overwrote the first ciphertext byte with "x", which is a no-op
// one time in 256 (the byte already was "x"), so the "tampered" value decrypted fine and
// CI failed on a PR that never touched this code. Flipping a bit always changes the byte.
check("tampering is detected", (() => { const p = sealed.split("."); const bytes = Buffer.from(p[3], "base64url"); bytes[0] ^= 0x01; p[3] = bytes.toString("base64url"); try { decryptSecret(p.join(".")); return false; } catch { return true; } })());
const goodKey = process.env.TOTP_ENCRYPTION_KEY;
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
check("a different key cannot read it", (() => { try { decryptSecret(sealed); return false; } catch { return true; } })());
delete process.env.TOTP_ENCRYPTION_KEY;
check("with no key it refuses to encrypt (fails closed)", (() => { try { encryptSecret(secret); return false; } catch (e) { return /TOTP_ENCRYPTION_KEY/.test(String(e)); } })());
process.env.TOTP_ENCRYPTION_KEY = Buffer.alloc(16, 1).toString("base64");
check("a key of the wrong size is refused", (() => { try { encryptSecret(secret); return false; } catch { return true; } })());
process.env.TOTP_ENCRYPTION_KEY = goodKey;

console.log("\nrecovery codes");
check("hash ignores case, dashes and spaces", hashRecoveryCode("abcde-fghij") === hashRecoveryCode("ABCDE FGHIJ") && hashRecoveryCode("ABCDEFGHIJ") === hashRecoveryCode("abcde-fghij"));
check("different codes hash differently", hashRecoveryCode("ABCDE-FGHIJ") !== hashRecoveryCode("ABCDE-FGHIK"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks FAILED.`);
process.exit(failures === 0 ? 0 : 1);
