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
  hashPasswordWith,
  verifyPassword,
  checkPassword,
  needsRehash,
  engine,
  deriveKey,
  LEGACY_PARAMS,
  CURRENT_PARAMS,
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

console.log("\nscrypt itself (RFC 7914 §12 test vectors)");
// The primitive is checked against the published vectors, not just against itself: if these
// match, a hash this app writes is one any scrypt implementation would compute. (A fourth vector
// needs a gigabyte; these three are enough to pin the parameter handling, N, r and p.)
const rfcVectors: [string, string, string, { N: number; r: number; p: number }, string][] = [
  ["empty password and salt", "", "", { N: 16, r: 1, p: 1 }, "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"],
  ["'password' / 'NaCl'", "password", "NaCl", { N: 1024, r: 8, p: 16 }, "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"],
  ["'pleaseletmein' / 'SodiumChloride'", "pleaseletmein", "SodiumChloride", { N: 16384, r: 8, p: 1 }, "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887"],
];
for (const [label, password, salt, params, expected] of rfcVectors) {
  check(`${label}, N=${params.N} r=${params.r} p=${params.p}`, (await deriveKey(password, Buffer.from(salt), params)).toString("hex") === expected);
}

console.log("\nThe two stored formats");
check("the legacy cost is Node's defaults, N=2^14 r=8 p=1", LEGACY_PARAMS.N === 2 ** 14 && LEGACY_PARAMS.r === 8 && LEGACY_PARAMS.p === 1);
check("the new cost is OWASP's N=2^16 r=8 p=2", CURRENT_PARAMS.N === 2 ** 16 && CURRENT_PARAMS.r === 8 && CURRENT_PARAMS.p === 2);

// Written by the code that was on main BEFORE this change. If these stop verifying, every
// existing user is locked out, and no round-trip test through today's code would notice.
const LEGACY_GOLDEN =
  "scrypt$a6433270c5409ed5edb92191c56f0e29$7a9af6ae3372bbef41f16a052d26e8896b12e544b9e88b5cd4695fd930d6660f809512ba7a4bae5f8c114621c035ad8474c63f2112b22cc4d35e66d7c7a89c32";
check("a hash written before this change still verifies", await verifyPassword("legacy-golden-Password-1!", LEGACY_GOLDEN));
check("and only for its own password", !(await verifyPassword("legacy-golden-Password-2!", LEGACY_GOLDEN)));

// Assembled with a fixed salt and Node's scryptSync directly, not through the code under test, so a
// change to the format or the derivation shows up here. It pins today's behaviour; the RFC vectors
// above are what vouch for the primitive.
const CURRENT_GOLDEN =
  "scrypt$ln=16,r=8,p=2$000102030405060708090a0b0c0d0e0f$8b56277d7a2c2091574bf448f52229a74be2a1f72d4977495a5e177eddf57cfb16f1886c84f2ab21be300e9c696a7d48f26cdfd8cdb28ab07357c74b60cf65c7";
check("a hash in the new format verifies", await verifyPassword("current-golden-Password-1!", CURRENT_GOLDEN));
check("and only for its own password", !(await verifyPassword("current-golden-Password-2!", CURRENT_GOLDEN)));
check("with one digit of the hash changed, it does not", !(await verifyPassword("current-golden-Password-1!", CURRENT_GOLDEN.replace(/.$/, "6"))));
check("with the declared cost changed, it does not (the cost is part of the answer)", !(await verifyPassword("current-golden-Password-1!", CURRENT_GOLDEN.replace("p=2", "p=3"))));

const atLegacy = await hashPasswordWith("Round-Trip-1", LEGACY_PARAMS);
const atCurrent = await hashPasswordWith("Round-Trip-1", CURRENT_PARAMS);
check("a legacy-cost hash is written in the legacy format (three fields)", atLegacy.split("$").length === 3 && atLegacy.startsWith("scrypt$"), atLegacy.slice(0, 22));
check("a current-cost hash carries its parameters (four fields)", atCurrent.startsWith("scrypt$ln=16,r=8,p=2$") && atCurrent.split("$").length === 4, atCurrent.slice(0, 22));
check("each verifies, for the right password only",
  (await verifyPassword("Round-Trip-1", atLegacy)) && (await verifyPassword("Round-Trip-1", atCurrent)) &&
  !(await verifyPassword("Round-Trip-2", atLegacy)) && !(await verifyPassword("Round-Trip-2", atCurrent)));

// Inverted from the change that taught the code to READ this format (#169), which asserted the
// opposite until every instance could. Writing it is safe now; checked here so the writer cannot
// quietly slip back to the weak cost.
check("hashPassword now WRITES the current cost, with its parameters", stored.startsWith("scrypt$ln=16,r=8,p=2$") && stored.split("$").length === 4, stored.slice(0, 22));
check("and a password it wrote verifies", await verifyPassword("Correct-Horse-9", stored));

console.log("\nA stored hash cannot ask for something we would not run");
const salt32 = "00".repeat(16), hash128 = "00".repeat(64);
const hostile: [string, string][] = [
  ["a cost far above the cap (ln=30)", `scrypt$ln=30,r=8,p=2$${salt32}$${hash128}`],
  ["a cost below the floor (ln=13)", `scrypt$ln=13,r=8,p=2$${salt32}$${hash128}`],
  ["above the ceiling (ln=19)", `scrypt$ln=19,r=8,p=2$${salt32}$${hash128}`],
  ["a different block size (r=1)", `scrypt$ln=16,r=1,p=2$${salt32}$${hash128}`],
  ["a huge block size (r=99)", `scrypt$ln=16,r=99,p=2$${salt32}$${hash128}`],
  ["no parallelism (p=0)", `scrypt$ln=16,r=8,p=0$${salt32}$${hash128}`],
  ["too much parallelism (p=9)", `scrypt$ln=16,r=8,p=9$${salt32}$${hash128}`],
  ["a missing parameter", `scrypt$ln=16,r=8$${salt32}$${hash128}`],
  ["the parameters spelt another way", `scrypt$N=65536,r=8,p=2$${salt32}$${hash128}`],
  ["upper case", `scrypt$LN=16,R=8,P=2$${salt32}$${hash128}`],
  ["trailing junk", `scrypt$ln=16,r=8,p=2,x=1$${salt32}$${hash128}`],
  ["five fields", `scrypt$ln=16,r=8,p=2$extra$${salt32}$${hash128}`],
  ["no salt", `scrypt$ln=16,r=8,p=2$$${hash128}`],
  ["no hash", `scrypt$ln=16,r=8,p=2$${salt32}$`],
  ["the maximum allowed cost with the maximum parallelism (needs over 256 MiB, which Node refuses)", `scrypt$ln=18,r=8,p=8$${salt32}$${hash128}`],
  // Inside every single bound, and still eight times the intended work: refused by the cap on
  // N × p, or one wrong guess would cost several seconds of CPU.
  ["each parameter in range but eight times the work (ln=17, p=8)", `scrypt$ln=17,r=8,p=8$${salt32}$${hash128}`],
  ["and four times the work (ln=17, p=4)", `scrypt$ln=17,r=8,p=4$${salt32}$${hash128}`],
];
const allowedNeighbours = [
  `scrypt$ln=17,r=8,p=1$${salt32}$${hash128}`, // OWASP A
  `scrypt$ln=16,r=8,p=2$${salt32}$${hash128}`, // OWASP B, the one in use
  `scrypt$ln=15,r=8,p=3$${salt32}$${hash128}`, // OWASP C
  `scrypt$ln=14,r=8,p=5$${salt32}$${hash128}`, // OWASP D
];
const hostileStart = performance.now();
const hostileResults: string[] = [];
for (const [label, value] of hostile) {
  if (await verifyPassword("anything", value)) hostileResults.push(label);
}
const hostileMs = performance.now() - hostileStart;
check("every one is refused, none throws", hostileResults.length === 0, hostileResults.join("; "));
// Refusing means not running scrypt at all: ln=18 would take seconds and 256 MiB if it were tried.
check("and quickly — refused up front, not computed and then rejected", hostileMs < 2000, `${hostileMs.toFixed(0)} ms for ${hostile.length}`);
// The cap must not refuse the settings it is meant to allow. These are real derivations (a
// second or so each on a slow machine) with a salt and hash that cannot match, so each is run
// and answers false: reaching false by computing is the proof it was not refused up front.
const ran: string[] = [];
for (const value of allowedNeighbours) {
  const t = performance.now();
  const answer = await verifyPassword("anything", value);
  if (answer === false && performance.now() - t > 20) ran.push(value.split("$")[1]);
}
check("while every OWASP-listed equivalent is still accepted and computed", ran.length === allowedNeighbours.length, ran.join(" | "));

console.log("\nWhich hashes want rewriting");
check("a legacy hash does", needsRehash(LEGACY_GOLDEN));
check("a current one does not", !needsRehash(CURRENT_GOLDEN));
check("an OWASP-equivalent at another cost does (it is not the cost in use)", needsRehash(`scrypt$ln=15,r=8,p=3$${salt32}$${hash128}`));
check("a hash nobody can read is left alone, not 'upgraded' into something else", !needsRehash("nonsense") && !needsRehash(`scrypt$ln=30,r=8,p=2$${salt32}$${hash128}`));

console.log("\nEvery failed sign-in costs the same");
// checkPassword stands one derivation counter in place of the real thing and reports what each
// attempt computed. Costs are compared by what RAN, not by how long it took: a loaded CI machine
// makes a stopwatch a coin flip, and "one legacy derivation and one current derivation" is the
// whole property.
const kind = (p: { N: number; r: number; p: number }) =>
  p.N === LEGACY_PARAMS.N && p.p === LEGACY_PARAMS.p ? "legacy" : p.N === CURRENT_PARAMS.N && p.p === CURRENT_PARAMS.p ? "current" : `other(${p.N}/${p.p})`;
async function attempt(password: string, storedHash: string | null | undefined) {
  const computed: string[] = [];
  const real = engine.derive;
  engine.derive = (pw, salt, params) => {
    computed.push(kind(params));
    return real(pw, salt, params);
  };
  try {
    const result = await checkPassword(password, storedHash);
    return { ...result, computed: computed.sort().join("+") };
  } finally {
    engine.derive = real;
  }
}
const LEGACY_PW = "legacy-golden-Password-1!";
const CURRENT_PW = "current-golden-Password-1!";
const failedAttempts: [string, Awaited<ReturnType<typeof attempt>>][] = [
  ["no such account (no hash)", await attempt("guess", null)],
  ["an account with no password set", await attempt("guess", "")],
  ["a row that cannot be read", await attempt("guess", "nonsense")],
  ["a row asking for a cost we would not run", await attempt("guess", `scrypt$ln=30,r=8,p=2$${salt32}$${hash128}`)],
  ["a legacy hash, wrong password", await attempt("guess", LEGACY_GOLDEN)],
  ["a current hash, wrong password", await attempt("guess", CURRENT_GOLDEN)],
];
for (const [label, result] of failedAttempts) {
  check(`${label}: refused after one legacy-cost and one current-cost derivation`, result.computed === "current+legacy" && !result.ok && result.rehash === null, result.computed);
}
check("so no failure can be told from another by the work it did", new Set(failedAttempts.map(([, r]) => r.computed)).size === 1);

console.log("\nA correct sign-in");
const rightLegacy = await attempt(LEGACY_PW, LEGACY_GOLDEN);
check("on a legacy hash is accepted", rightLegacy.ok);
check("and hands back a stronger hash, in the current format", rightLegacy.rehash !== null && rightLegacy.rehash.startsWith("scrypt$ln=16,r=8,p=2$"), String(rightLegacy.rehash).slice(0, 22));
check("that verifies with the same password, and is not itself due for rewriting", rightLegacy.rehash !== null && (await verifyPassword(LEGACY_PW, rightLegacy.rehash)) && !needsRehash(rightLegacy.rehash));
check("computed once, not twice: the check and the new hash, nothing more", rightLegacy.computed === "current+legacy", rightLegacy.computed);
const again = await attempt(LEGACY_PW, LEGACY_GOLDEN);
check("two upgrades of one password differ (a fresh salt each time)", again.rehash !== null && again.rehash !== rightLegacy.rehash);
const rightCurrent = await attempt(CURRENT_PW, CURRENT_GOLDEN);
check("on a current hash is accepted", rightCurrent.ok);
check("and needs no upgrade, so does only the one derivation", rightCurrent.rehash === null && rightCurrent.computed === "current", rightCurrent.computed);
const wrongPasswordOnLegacy = await attempt("not the password", LEGACY_GOLDEN);
check("a wrong password never produces an upgrade, so a guess cannot rewrite anyone's hash", !wrongPasswordOnLegacy.ok && wrongPasswordOnLegacy.rehash === null);

console.log("\nThe sign-in action");
// Read from source, comments out, because the action is a server action and cannot be called
// from here. What is asserted is the shape that makes the two properties above hold in practice.
const loginSource = readFileSync("src/lib/auth-actions.ts", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");
check("it checks the password with checkPassword, for an account that exists or not", /checkPassword\(\s*password,\s*user\?\.passwordHash\s*\)/.test(loginSource));
check("and no longer verifies against a separate dummy hash (which cost the wrong amount)", !/\bverifyPassword\b/.test(loginSource) && !/DUMMY_HASH/.test(loginSource));
check("the upgraded hash is stored with a compare-and-swap on the hash it verified",
  /updateMany\(\s*\{\s*where:\s*\{\s*id:\s*userId,\s*passwordHash:\s*was\s*\}/.test(loginSource));
check("never with an update by id, which would put an OLD password's hash back over a new one", !/user\.update\(\s*\{\s*where:\s*\{\s*id:\s*userId\s*\}[^)]*passwordHash/.test(loginSource));
const upgradeAt = loginSource.indexOf("upgradeHash(user.id");
check("it runs only after the password is proven and the temporary-password expiry is checked",
  upgradeAt > loginSource.indexOf("check.ok") && upgradeAt > loginSource.indexOf("TEMP_PASSWORD_DAYS *"), "");
check("and its failure cannot fail a correct sign-in", /async function upgradeHash[\s\S]*?try\s*\{[\s\S]*?\}\s*catch/.test(loginSource));

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
