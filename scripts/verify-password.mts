/**
 * Passwords: the hash round-trip, and a temporary password strong enough to be sprayed at.
 *
 * A temporary password is read aloud to a teacher or texted to a parent, so it has to be
 * dictatable. It is also the weakest credential the app issues: the login lockout limits one
 * address and one account, but an attacker who tries the same guess against many accounts
 * trips neither, so the only thing standing between the internet and a parent's portal is how
 * many passwords there are to guess. It was 72,000 (one word, one number); it is now about
 * 8 × 10^10. No database.
 *
 * Run: npm run verify:password
 */
import {
  hashPassword,
  verifyPassword,
  temporaryPassword,
  TEMP_PASSWORD_WORDS,
  TEMP_PASSWORD_SPACE,
} from "@/lib/password";

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}

console.log("Hashing");
const stored = await hashPassword("Correct-Horse-9");
check("the right password verifies", await verifyPassword("Correct-Horse-9", stored));
check("a wrong password does not", !(await verifyPassword("Correct-Horse-8", stored)));
check("a different case does not", !(await verifyPassword("correct-horse-9", stored)));
check("two hashes of one password differ (a fresh salt each time)", stored !== (await hashPassword("Correct-Horse-9")));
check("a malformed stored value is refused, not thrown on", !(await verifyPassword("x", "nonsense")) && !(await verifyPassword("x", "scrypt$$")));
check("an unknown algorithm is refused", !(await verifyPassword("x", `bcrypt$${"00".repeat(16)}$${"00".repeat(64)}`)));

console.log("\nThe word list");
const words = [...TEMP_PASSWORD_WORDS];
check("thirty-two words", words.length === 32, String(words.length));
check("none repeated", new Set(words.map((w) => w.toLowerCase())).size === words.length);
check("each is one capitalised word of plain letters", words.every((w) => /^[A-Z][a-z]{2,9}$/.test(w)), words.filter((w) => !/^[A-Z][a-z]{2,9}$/.test(w)).join(", "));

console.log("\nHow many passwords there are to guess");
const expectedSpace = words.length * (words.length - 1) * 9000 * 9000;
check("the space is what the format says it is", TEMP_PASSWORD_SPACE === expectedSpace, String(TEMP_PASSWORD_SPACE));
// 2^35 ≈ 3.4 × 10^10 attempts. The number is a floor, not a target: what it guards is someone
// shrinking the list or the format back toward the 16 bits this started at.
check(
  "at least 35 bits — a hit on any account takes about this many attempts, whatever the number of accounts",
  TEMP_PASSWORD_SPACE >= 2 ** 35,
  `${Math.log2(TEMP_PASSWORD_SPACE).toFixed(1)} bits`,
);
check("and over a million times the 72,000 it replaced", TEMP_PASSWORD_SPACE > 72_000 * 1_000_000);

console.log("\nWhat temporaryPassword produces");
const FORMAT = /^([A-Z][a-z]+)(\d{4})([A-Z][a-z]+)(\d{4})!$/;
const samples = Array.from({ length: 20_000 }, () => temporaryPassword());
const parsed = samples.map((p) => FORMAT.exec(p));
check("every one is Word, four digits, Word, four digits, '!'", parsed.every(Boolean), samples.find((_, i) => !parsed[i]) ?? "");
const known = new Set<string>(words);
check("both words come from the list", parsed.every((m) => m && known.has(m[1]) && known.has(m[3])));
check("the two words are never the same", parsed.every((m) => m && m[1] !== m[3]));
check("each number is 1000–9999, never a leading zero", parsed.every((m) => m && Number(m[2]) >= 1000 && Number(m[4]) >= 1000));
check("long enough for the app's own 8-character minimum, short enough to type", samples.every((p) => p.length >= 8 && p.length <= 40), `${Math.min(...samples.map((p) => p.length))}–${Math.max(...samples.map((p) => p.length))}`);
check("1,000 in a row are all different", new Set(samples.slice(0, 1000)).size === 1000);

const firstSeen = new Set(parsed.map((m) => m![1]));
const secondSeen = new Set(parsed.map((m) => m![3]));
check("every word turns up in the first position", firstSeen.size === words.length, `${firstSeen.size} of ${words.length}`);
check("and in the second — the 'step over the first' draw reaches them all", secondSeen.size === words.length, `${secondSeen.size} of ${words.length}`);

// The second word is drawn from the other thirty-one. If that step-over were off by one, one word
// would never follow another, or the last word would be favoured — look for a lopsided position.
const counts = new Map<string, number>();
for (const m of parsed) counts.set(m![3], (counts.get(m![3]) ?? 0) + 1);
const expected = samples.length / words.length;
const worst = Math.max(...[...counts.values()].map((c) => Math.abs(c - expected) / expected));
check("the second word is evenly spread (no favoured word)", worst < 0.2, `worst deviation ${(worst * 100).toFixed(1)}% from even`);

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
