/**
 * Online payments, the rules that need no database and no network.
 *
 *   npm run verify:paystack
 *
 * What a parent's Paystack payment may turn into, and what must never. Pinned here: the key a school
 * pastes, the pesewas arithmetic, the webhook signature, what Paystack's answers mean (an
 * "abandoned" transaction is waiting, never failed), what counts as the payment we asked for, the
 * encryption of the school's key, and the SHAPE of the code around it, read from source with
 * comments stripped (this codebase explains its mistakes at length, and the words would satisfy a
 * search for the thing they warn about).
 *
 * The HTTP half (a forged webhook refused, a real signed one booked, a replay booking once) is
 * verify:online-payments.
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { Prisma } from "@prisma/client";

// The master key must exist before the crypto module is first used.
process.env.TOTP_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");

const {
  parseSecretKey,
  toPesewas,
  newReference,
  signatureMatches,
  looksLikeSignature,
  momoNetwork,
  verifyTransaction,
  initializeTransaction,
  testKey,
  transactionMatches,
} = await import("@/lib/paystack");
const { encryptGatewaySecret, decryptGatewaySecret } = await import("@/lib/gateway-crypto");
const { encryptSecret, decryptSecret } = await import("@/lib/totp-crypto");

let failures = 0;
function check(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures += 1;
}
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const SK = "sk_test_" + "a1B2c3D4e5F6g7H8i9J0";

console.log("The key a school pastes");
check("a test secret key is accepted and read as test", (() => { const r = parseSecretKey(SK); return r.ok && r.mode === "test" && r.key === SK; })());
check("a live secret key is read as live", (() => { const r = parseSecretKey("sk_live_" + "x".repeat(30)); return r.ok && r.mode === "live"; })());
check("surrounding spaces from a paste are trimmed", parseSecretKey(`  ${SK}\n`).ok);
const pub = parseSecretKey("pk_test_" + "a".repeat(30));
check("a PUBLIC key is refused, and the message says which one to paste", !pub.ok && /secret/i.test(pub.error));
for (const bad of ["", "sk_test_", "sk_test_short", "hello", "sk_demo_" + "a".repeat(30), "sk_test_" + "a".repeat(30) + "$$"]) {
  check(`"${bad.slice(0, 24)}" is refused`, !parseSecretKey(bad).ok);
}

console.log("\nCedis to pesewas, exactly");
check("250.00 is 25000 pesewas", toPesewas("250.00") === 25000);
check("0.01 is 1", toPesewas("0.01") === 1);
check("a Decimal works", toPesewas(new Prisma.Decimal("1234.56")) === 123456);
check("0.1 + 0.2 is exactly 30 (no float drift)", toPesewas(new Prisma.Decimal("0.1").add("0.2")) === 30);
check("a third of a pesewa is refused, not rounded", toPesewas("10.005") === null);
check("zero is refused", toPesewas("0") === null);
check("a negative is refused", toPesewas("-5") === null);

console.log("\nReferences");
const refA = newReference(randomBytes(12));
check("a reference is SOS- and 24 upper-case hex digits", /^SOS-[0-9A-F]{24}$/.test(refA), refA);
check("two references differ", refA !== newReference(randomBytes(12)));

console.log("\nThe webhook signature");
const body = JSON.stringify({ event: "charge.success", data: { reference: refA, amount: 25000 } });
const sig = createHmac("sha512", SK).update(body).digest("hex");
check("the HMAC-SHA512 of the raw body under the school's key matches", signatureMatches(body, sig, SK));
check("an upper-case hex signature is the same signature", signatureMatches(body, sig.toUpperCase(), SK));
check("a different key does not match", !signatureMatches(body, sig, "sk_test_" + "z".repeat(20)));
check("one changed byte in the body does not match", !signatureMatches(body.replace("25000", "25001"), sig, SK));
check("re-serialised JSON does not match (it is the RAW bytes that are signed)", !signatureMatches(JSON.stringify(JSON.parse(body), null, 2), sig, SK));
for (const [label, value] of [["missing", null], ["empty", ""], ["short", sig.slice(0, 127)], ["long", sig + "a"], ["not hex", "z".repeat(128)]] as const) {
  check(`${label} signature is false, never a throw`, signatureMatches(body, value, SK) === false);
}
check("looksLikeSignature is the cheap pre-check: 128 hex digits and nothing else", looksLikeSignature(sig) && !looksLikeSignature("abc") && !looksLikeSignature(null));

console.log("\nWhat Paystack's answers mean");
type Json = Record<string, unknown>;
const reply = (status: number, json: unknown) => async () => new Response(typeof json === "string" ? json : JSON.stringify(json), { status });
const fetchOf = (impl: () => Promise<Response>) => ((async () => impl()) as unknown as typeof fetch);
const tx = (extra: Json = {}) => ({ status: true, data: { status: "success", reference: refA, amount: 25000, currency: "GHS", channel: "mobile_money", authorization: { bank: "MTN" }, ...extra } });

const ok = await verifyTransaction(SK, refA, fetchOf(reply(200, tx())));
check("a successful MoMo payment is success with its amount in pesewas and the network", ok.state === "success" && ok.transaction.amountPesewas === 25000 && ok.transaction.network === "MTN" && ok.transaction.channel === "mobile_money");
const card = await verifyTransaction(SK, refA, fetchOf(reply(200, tx({ channel: "card", authorization: { brand: "visa" } }))));
check("a card payment has no MoMo network", card.state === "success" && card.transaction.network === null && card.transaction.channel === "card");
check("Telecel (formerly Vodafone) and AirtelTigo are named", momoNetwork("Vodafone") === "TELECEL" && momoNetwork("Telecel Cash") === "TELECEL" && momoNetwork("AirtelTigo") === "AIRTELTIGO" && momoNetwork("whatever") === null);
for (const status of ["abandoned", "pending", "ongoing", "processing", "queued"]) {
  const r = await verifyTransaction(SK, refA, fetchOf(reply(200, tx({ status }))));
  check(`"${status}" is WAITING, never failed (the parent can still finish)`, r.state === "pending");
}
for (const status of ["failed", "reversed"]) {
  const r = await verifyTransaction(SK, refA, fetchOf(reply(200, tx({ status }))));
  check(`"${status}" is failed`, r.state === "failed");
}
check("a 404 (no such transaction yet) is waiting", (await verifyTransaction(SK, refA, fetchOf(reply(404, { status: false, message: "Transaction reference not found" })))).state === "pending");
check("a 401 is an error carrying Paystack's words, not a failure of the payment", await verifyTransaction(SK, refA, fetchOf(reply(401, { status: false, message: "Invalid key" }))).then((r) => r.state === "error" && /Invalid key/.test(r.reason)));
check("an HTML error page is an error, not a throw", (await verifyTransaction(SK, refA, fetchOf(reply(502, "<html>Bad gateway</html>")))).state === "error");
check("a dropped connection is an error, not a throw", (await verifyTransaction(SK, refA, fetchOf(async () => { throw new Error("socket"); }))).state === "error");
check("a success with a fractional amount is refused as malformed", (await verifyTransaction(SK, refA, fetchOf(reply(200, tx({ amount: 250.5 }))))).state === "error");
check("a success with no reference is refused as malformed", (await verifyTransaction(SK, refA, fetchOf(reply(200, tx({ reference: undefined }))))).state === "error");

console.log("\nAsking the right thing");
const seen: { url?: string; init?: RequestInit } = {};
const spy = ((url: string, init: RequestInit) => { seen.url = url; seen.init = init; return Promise.resolve(new Response(JSON.stringify({ status: true, data: { authorization_url: "https://checkout.paystack.com/abc" } }), { status: 200 })); }) as unknown as typeof fetch;
const started = await initializeTransaction(SK, { email: "p@example.com", amountPesewas: 25000, reference: refA, callbackUrl: "https://x.test/portal/s/fees?ref=" + refA, metadata: { a: "b" } }, spy);
const sent = JSON.parse(String(seen.init?.body ?? "{}"));
check("initialize returns the checkout address", started.ok && started.url.startsWith("https://checkout.paystack.com/"));
check("it sends the amount as integer pesewas in GHS", sent.amount === 25000 && Number.isInteger(sent.amount) && sent.currency === "GHS");
check("it offers mobile money and card", Array.isArray(sent.channels) && sent.channels.includes("mobile_money") && sent.channels.includes("card"));
check("it sends our reference and uses the school's key as a bearer token", sent.reference === refA && (seen.init?.headers as Record<string, string> | undefined)?.Authorization === `Bearer ${SK}`);
check("it talks to Paystack's API over https", String(seen.url).startsWith("https://api.paystack.co/transaction/initialize"));
check("a refusal carries Paystack's message", await initializeTransaction(SK, { email: "p@example.com", amountPesewas: 1, reference: refA, callbackUrl: "x", metadata: {} }, fetchOf(reply(400, { status: false, message: "Invalid amount" }))).then((r) => !r.ok && /Invalid amount/.test(r.error)));
check("testKey accepts a key Paystack opens", (await testKey(SK, fetchOf(reply(200, { status: true, data: [] })))).ok);
check("testKey says 'did not accept' for a 401", await testKey(SK, fetchOf(reply(401, { status: false }))).then((r) => !r.ok && /did not accept/.test(r.error)));

console.log("\nIs it the payment we asked for?");
const asked = { reference: refA, amount: new Prisma.Decimal("250.00") };
const good = { reference: refA, amountPesewas: 25000, currency: "GHS", channel: "mobile_money", network: "MTN" as const };
check("same reference, amount and cedis: yes", transactionMatches(asked, good).ok);
check("a smaller amount is NOT booked", !transactionMatches(asked, { ...good, amountPesewas: 24999 }).ok);
check("a larger amount is NOT booked either (it is not what was agreed)", !transactionMatches(asked, { ...good, amountPesewas: 25001 }).ok);
check("dollars are NOT booked as cedis", !transactionMatches(asked, { ...good, currency: "USD" }).ok);
check("a different reference is NOT booked", !transactionMatches(asked, { ...good, reference: "SOS-" + "0".repeat(24) }).ok);

console.log("\nThe school's key at rest");
const stored = encryptGatewaySecret(SK);
check("it round-trips", decryptGatewaySecret(stored) === SK);
check("the stored form does not contain the key", !stored.includes(SK) && !stored.includes(SK.slice(8)));
check("encrypting twice gives different text (a fresh nonce each time)", encryptGatewaySecret(SK) !== stored);
check("a tampered ciphertext is refused", (() => { try { decryptGatewaySecret(stored.slice(0, -2) + (stored.endsWith("AA") ? "BB" : "AA")); return false; } catch { return true; } })());
check("an authenticator secret's ciphertext does NOT decrypt as a gateway key (different subkey)", (() => { try { decryptGatewaySecret(encryptSecret(Buffer.from(SK))); return false; } catch { return true; } })());
check("and a gateway ciphertext does not decrypt as an authenticator secret", (() => { try { decryptSecret(stored); return false; } catch { return true; } })());
check("with no master key it fails closed", (() => { const kept = process.env.TOTP_ENCRYPTION_KEY; delete process.env.TOTP_ENCRYPTION_KEY; try { encryptGatewaySecret(SK); return false; } catch { return true; } finally { process.env.TOTP_ENCRYPTION_KEY = kept; } })());

console.log("\nThe shape of the code around it");
const webhook = code("src/app/api/paystack/webhook/[schoolId]/route.ts");
const w = (needle: string) => webhook.indexOf(needle);
check("a malformed school id is refused BEFORE the budget or any query", w("looksLikeSchoolId(schoolId)") !== -1 && w("looksLikeSchoolId(schoolId)") < w("publicLookup("));
check("a missing or malformed signature is refused before any query", w("looksLikeSignature(signature)") !== -1 && w("looksLikeSignature(signature)") < w("publicLookup("));
check("the body is read as raw text, never request.json() (the signature covers the raw bytes)", /request\.text\(\)/.test(webhook) && !/request\.json\(\)/.test(webhook));
check("the key is read INSIDE the budget", w("publicLookup(") < w("prisma.paymentGateway"));
check("the signature is checked BEFORE anything is believed or settled", w("signatureMatches(") !== -1 && w("signatureMatches(") < w("JSON.parse(rawBody)") && w("JSON.parse(rawBody)") < w("settleOnlinePayment("));
check("a full queue answers 503", /isBusy\(error\)/.test(webhook) && /busyResponse\(\)/.test(webhook));
check("a school with no key and a bad signature give the same answer (no probing which schools take payments)", (webhook.match(/return unauthorized\(\)/g) ?? []).length >= 4);
check("only the reference is taken from the body", !/event\.data\??\.amount|data\.amount|\.metadata/.test(webhook));

const engine = code("src/lib/online-payment-engine.ts");
check("settling never passes the caller's amount or pupil: its only inputs are a school and a reference", /settleOnlinePayment\(\s*schoolId: string,\s*reference: string/.test(engine));
check("the booking and the flip to PAID share one transaction under an advisory lock", /tenantTransaction\(schoolId/.test(engine) && /pg_advisory_xact_lock/.test(engine) && engine.indexOf("bookPayment(") < engine.indexOf('status: "PAID"'));
check("the row is re-read UNDER the lock and a PAID one books nothing", /fresh\.status === "PAID"/.test(engine));
check("the outcome is Paystack's answer to our own call, compared with OUR row", /verifyTransaction\)\(secretKey, reference\)/.test(engine) && /transactionMatches\(\{ reference, amount: attempt\.amount \}/.test(engine));
check("a lapsed (read-only) school's payment is still recorded: no readOnly in the settlement context", !/readOnly/.test(engine));
check("the receipt text is after the commit and cannot undo it", engine.indexOf("await sendReceiptSms(") > engine.lastIndexOf("tenantTransaction(schoolId") && /catch \{/.test(engine));

const actions = code("src/lib/online-payment-actions.ts");
const fn = (name: string) => actions.slice(actions.indexOf(`export async function ${name}`));
check("saving the key is LEADERSHIP only (the IT admin is kept out of the money)", /requireRole\(LEADERSHIP\)/.test(fn("saveGatewayKey").slice(0, 400)) && !/FINANCE|OFFICE/.test(actions));
check("the key is checked against Paystack before it is stored", fn("saveGatewayKey").indexOf("testKey(") !== -1 && fn("saveGatewayKey").indexOf("testKey(") < fn("saveGatewayKey").indexOf("encryptGatewaySecret("));
check("a newly saved key starts switched OFF", /enabled: false/.test(fn("saveGatewayKey")));
check("the key is never written to the audit trail or returned", !/after:\s*\{[^}]*(secret|key:)/i.test(actions.replace(/mode: parsed\.mode/g, "")) && !/return \{[^}]*parsed\.key/.test(actions));
check("a parent's checkout is for THEIR child (requireMyChild) and nobody else's", /requireMyChild\(studentId\)/.test(fn("startCheckout")) && /requireMyChild\(studentId\)/.test(fn("confirmOnlinePayment")));
check("the amount is held to what is owing, read on the server", /getChildFinance\(studentId\)/.test(fn("startCheckout")) && /amount\.greaterThan\(owing\)/.test(fn("startCheckout")));
check("our row (with OUR amount) is written before the parent leaves for Paystack", fn("startCheckout").indexOf("onlinePayment.create") < fn("startCheckout").indexOf("initializeTransaction("));
check("the return page can only ask about a reference of this child", /where:\s*\{\s*schoolId: ctx\.schoolId, reference, studentId\s*\}/.test(fn("confirmOnlinePayment")));

const booking = code("src/lib/payment-booking.ts");
const office = code("src/lib/payment-actions.ts");
check("the office form and Paystack book money through the SAME function", /bookPayment\(/.test(office) && /bookPayment\(/.test(engine));
check("there is exactly one place that allocates a payment", !/allocateFifo/.test(office) && !/allocateFifo/.test(engine) && /allocateFifo/.test(booking));

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
