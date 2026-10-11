/**
 * Passwords: the hash round-trip, and a temporary password strong enough to be sprayed at.
 *
 * A temporary password is read aloud to a teacher or texted to a parent, so it has to be
 * dictatable. It is also the weakest credential the app issues: the login lockout limits one
 * address and one account, but an attacker who tries the same guess against many accounts
 * trips neither, so the only thing standing between the internet and a parent's portal is how
 * many passwords there are to guess. It was 72,000 (one word, one number); it is now about
 * 8 × 10^10. And once issued it must not be KEPT: the guardian-invite text carries the password,
 * and the message log is read by staff and sits in backups, so the log gets a masked copy. No
 * database.
 *
 * Run: npm run verify:password
 */
import { readFileSync } from "node:fs";
import {
  hashPassword,
  verifyPassword,
  temporaryPassword,
  TEMP_PASSWORD_WORDS,
  TEMP_PASSWORD_SPACE,
  TEMP_PASSWORD_MAX_LENGTH,
} from "@/lib/password";
import { inviteMessage, inviteMessages, STORED_PASSWORD_MASK } from "@/lib/portal-invite-data";

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

console.log("\nThe longest a password can be");
const longestWords = [...words].sort((a, b) => b.length - a.length);
check(
  "TEMP_PASSWORD_MAX_LENGTH is the two longest words, two groups and the '!'",
  TEMP_PASSWORD_MAX_LENGTH === longestWords[0].length + longestWords[1].length + 9,
  String(TEMP_PASSWORD_MAX_LENGTH),
);
check("no password ever runs past it", samples.every((p) => p.length <= TEMP_PASSWORD_MAX_LENGTH), `longest seen ${Math.max(...samples.map((p) => p.length))}`);

console.log("\nThe invite text, sent and kept");
const invite = { schoolName: "Hope Education Complex", guardianFirstName: "Ama", identifier: "233244123456", url: "https://www.schoolosafrica.com/login" };
const sampleAtMax = inviteMessage({ ...invite, password: "x".repeat(TEMP_PASSWORD_MAX_LENGTH) });
let neverLow = true;
let sentWithoutIt = 0;
let storedWithIt = 0;
let otherwiseSame = true;
const inviteSamples = samples.slice(0, 2000);
for (const password of inviteSamples) {
  const { send, store } = inviteMessages({ ...invite, password });
  if (!send.includes(password)) sentWithoutIt += 1; // the parent must actually receive it
  if (store.includes(password)) storedWithIt += 1; // the log must not keep it
  if (send.replace(password, STORED_PASSWORD_MASK) !== store) otherwiseSame = false;
  if (send.length > sampleAtMax.length) neverLow = false;
}
check("the text SENT carries the password, or the parent cannot sign in", sentWithoutIt === 0, `${sentWithoutIt} of ${inviteSamples.length} without it`);
check("the text STORED never does", storedWithIt === 0, `${storedWithIt} of ${inviteSamples.length} stored it`);
check("the two differ only in the password", otherwiseSame);
check("the stored copy says it was deliberate", inviteMessages({ ...invite, password: "Kente4829Odum7316!" }).store.includes(`password ${STORED_PASSWORD_MASK}.`));
check("the cost estimate (the longest possible password) is never lower than a real message", neverLow);

// The helper is only half the guarantee: the action has to STORE `store` and SEND `send`. Read
// the source, comments out, because this codebase explains its mistakes at length and the
// sentence about "never store body" would otherwise satisfy any search for it.
const source = readFileSync("src/lib/portal-invite-actions.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
const create = source.slice(source.indexOf("message.create("), source.indexOf("message.create(") + 400);
check("the invite action stores the masked copy (body: storedBody)", /\bbody:\s*storedBody\b/.test(create));
check("and never the raw text, however it is spelt", !/\bbody\s*,/.test(create) && !/\bbody:\s*body\b/.test(create));
check("it sends the real one", /sendSms\(\s*c\.phone,\s*body\b/.test(source));
check("and counts segments and cost from what is sent, not the masked copy", /countSegments\(\s*body\s*\)/.test(source));

// getInvitePlan prices the whole run from ONE sample message. It must be the longest a real one
// can be, or the estimate on the invite screen comes in under what the school is charged.
const planSource = readFileSync("src/lib/portal-invite-data.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check(
  "the invite screen's cost sample uses the longest possible password",
  /password:\s*"x"\.repeat\(\s*TEMP_PASSWORD_MAX_LENGTH\s*\)/.test(planSource),
);

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
