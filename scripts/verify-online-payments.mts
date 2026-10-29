/**
 * A parent's online payment, settled for real against a database.
 *
 *   npm run verify:online-payments        (the HTTP half needs `npm run dev` or the built app)
 *
 * `verify:paystack` pins the rules with no database. This runs `settleOnlinePayment` itself, with
 * Paystack's answer replaced by a fake, against the real tables and the real booking code, and then
 * posts to the real webhook route.
 *
 * Money that must not move twice: a replayed webhook, and two arriving at once, book ONE payment.
 * Money that must not move at all: an amount that is not the one we asked for, dollars, a payment
 * still waiting, a reference that is another school's. Each is forced and each is looked for in the
 * payments table, not in the function's return value.
 *
 * Writes lasting rows (the settle path commits, by design), so everything is removed in `finally` on
 * the OWNER connection, and the pupil's invoices are put back to the figures they had. It leaves one
 * thing behind: the receipt counter has moved on, which only skips a number.
 *
 * Development and CI databases only.
 */
import { createHmac, randomBytes } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { settleOnlinePayment } from "@/lib/online-payment-engine";
import { encryptGatewaySecret } from "@/lib/gateway-crypto";
import type { VerifyResult } from "@/lib/paystack";
import { demoSchool, withOwner } from "./fixture.mjs";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const FAKE_SK = "sk_test_" + randomBytes(10).toString("hex");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail.slice(0, 300)}` : ""}`);
  if (!ok) failures += 1;
}
const ref = () => "SOS-" + randomBytes(12).toString("hex").toUpperCase();
const dec = (n: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(n ?? 0);

const school = await demoSchool();

await withOwner(async (owner: PrismaClient) => {
  // A pupil with a real balance to pay down.
  const invoice = await owner.invoice.findFirst({
    where: { schoolId: school.id, status: { not: "CANCELLED" }, balance: { gte: 40 }, student: { deletedAt: null } },
    orderBy: { issueDate: "asc" },
  });
  if (!invoice) {
    console.log("  --  no pupil owes GH₵40 or more in the seeded school; nothing to settle against. Run `npm run db:seed`.");
    failures += 1;
    return;
  }
  const studentId = invoice.studentId;
  const before = await owner.invoice.findMany({ where: { studentId } });
  const priorGateway = await owner.paymentGateway.findUnique({ where: { schoolId: school.id } });
  const refs: string[] = [];

  const enc = encryptGatewaySecret(FAKE_SK);
  await owner.paymentGateway.upsert({
    where: { schoolId: school.id },
    create: { schoolId: school.id, secretKeyEnc: enc, mode: "test", enabled: true },
    update: { secretKeyEnc: enc, mode: "test", enabled: true },
  });

  const attempt = async (amount: string) => {
    const reference = ref();
    refs.push(reference);
    await owner.onlinePayment.create({ data: { schoolId: school.id, studentId, reference, amount } });
    return reference;
  };
  const success = (reference: string, over: Partial<{ amountPesewas: number; currency: string; channel: string; network: "MTN" | null }> = {}) =>
    async (): Promise<VerifyResult> => ({
      state: "success",
      transaction: { reference, amountPesewas: 1000, currency: "GHS", channel: "mobile_money", network: "MTN", ...over },
    });
  const paymentsFor = (reference: string) => owner.payment.findMany({ where: { schoolId: school.id, providerRef: reference } });

  try {
    console.log("A confirmed payment is booked");
    const r1 = await attempt("10.00");
    const result = await settleOnlinePayment(school.id, r1, { verify: success(r1) });
    check("settling a confirmed, matching payment books it", result.state === "booked" && !!result.receiptNo, JSON.stringify(result));
    const booked = await paymentsFor(r1);
    check("exactly one Payment exists for the reference", booked.length === 1);
    const p = booked[0];
    check("it is GH₵10.00, MoMo on MTN, confirmed, against the pupil", !!p && dec(p.amount).equals(10) && p.method === "MOBILE_MONEY" && p.momoNetwork === "MTN" && p.status === "CONFIRMED" && p.studentId === studentId);
    check("nobody recorded it: no user is named, the audit row says it was online", !!p && p.recordedByUserId === null && (await owner.auditLog.count({ where: { schoolId: school.id, entityId: p.id, action: "payment.online" } })) === 1);
    check("providerRef and providerStatus are set", !!p && p.providerRef === r1 && p.providerStatus === "success");
    const allocated = p ? (await owner.paymentAllocation.findMany({ where: { paymentId: p.id } })).reduce((a, x) => a.add(x.amount), dec(0)) : dec(0);
    check("the whole GH₵10.00 is allocated to the pupil's invoices", allocated.equals(10), allocated.toString());
    const op = await owner.onlinePayment.findUnique({ where: { schoolId_reference: { schoolId: school.id, reference: r1 } } });
    check("the attempt is PAID and points at the payment", op?.status === "PAID" && op.paymentId === p?.id && !!op.paidAt && op.channel === "mobile_money");
    const afterInvoices = await owner.invoice.findMany({ where: { studentId } });
    const paidBefore = before.reduce((a, i) => a.add(i.amountPaid), dec(0));
    const paidAfter = afterInvoices.reduce((a, i) => a.add(i.amountPaid), dec(0));
    check("the invoices' amountPaid rose by exactly GH₵10.00", paidAfter.sub(paidBefore).equals(10), `${paidBefore} -> ${paidAfter}`);

    console.log("\nA replay books nothing");
    const again = await settleOnlinePayment(school.id, r1, { verify: success(r1) });
    check("settling a PAID attempt again says 'already'", again.state === "already");
    check("and there is still ONE payment", (await paymentsFor(r1)).length === 1);

    console.log("\nTwo at once book once");
    const r2 = await attempt("10.00");
    const [a, b] = await Promise.all([
      settleOnlinePayment(school.id, r2, { verify: success(r2) }),
      settleOnlinePayment(school.id, r2, { verify: success(r2) }),
    ]);
    const states = [a.state, b.state].sort().join("+");
    check("one books and the other finds it already booked", states === "already+booked", states);
    check("and there is ONE payment for the reference", (await paymentsFor(r2)).length === 1);

    console.log("\nMoney that is not what we asked for is not booked");
    const r3 = await attempt("10.00");
    const small = await settleOnlinePayment(school.id, r3, { verify: success(r3, { amountPesewas: 500 }) });
    check("a smaller amount is a mismatch", small.state === "mismatch", JSON.stringify(small));
    const big = await settleOnlinePayment(school.id, r3, { verify: success(r3, { amountPesewas: 5000 }) });
    check("a larger amount is a mismatch too", big.state === "mismatch");
    const usd = await settleOnlinePayment(school.id, r3, { verify: success(r3, { currency: "USD" }) });
    check("dollars are a mismatch", usd.state === "mismatch");
    const wrongRef = await settleOnlinePayment(school.id, r3, { verify: success("SOS-" + "0".repeat(24)) });
    check("an answer for a different reference is a mismatch", wrongRef.state === "mismatch");
    check("none of them booked a payment", (await paymentsFor(r3)).length === 0);
    const kept = await owner.onlinePayment.findUnique({ where: { schoolId_reference: { schoolId: school.id, reference: r3 } } });
    check("the attempt stays PENDING with the reason written on it for a person to read", kept?.status === "PENDING" && !!kept.problem, kept?.problem ?? "");

    console.log("\nA payment still waiting, then failed, then paid");
    const r4 = await attempt("10.00");
    check("pending books nothing", (await settleOnlinePayment(school.id, r4, { verify: async () => ({ state: "pending" }) })).state === "pending" && (await paymentsFor(r4)).length === 0);
    check("a failed attempt is marked FAILED and books nothing", (await settleOnlinePayment(school.id, r4, { verify: async () => ({ state: "failed", reason: "failed" }) })).state === "failed" && (await paymentsFor(r4)).length === 0);
    check("the row says FAILED", (await owner.onlinePayment.findUnique({ where: { schoolId_reference: { schoolId: school.id, reference: r4 } } }))?.status === "FAILED");
    const retry = await settleOnlinePayment(school.id, r4, { verify: success(r4) });
    check("FAILED is not final: the parent retried in the same checkout and it books", retry.state === "booked" && (await paymentsFor(r4)).length === 1);
    check("an unreachable Paystack is an error and books nothing", (await (async () => { const r = await attempt("10.00"); const res = await settleOnlinePayment(school.id, r, { verify: async () => ({ state: "error", reason: "down" }) }); return res.state === "error" && (await paymentsFor(r)).length === 0; })()));

    console.log("\nWhose reference is it?");
    check("a reference nobody made is unknown", (await settleOnlinePayment(school.id, ref(), { verify: success("x") })).state === "unknown");
    const other = await owner.school.findFirst({ where: { id: { not: school.id } }, select: { id: true } });
    if (other) {
      const r5 = await attempt("10.00");
      const cross = await settleOnlinePayment(other.id, r5, { verify: success(r5) });
      check("another school cannot settle this school's reference", cross.state === "unknown" && (await paymentsFor(r5)).length === 0, cross.state);
    } else {
      console.log("  --  only one school in this database; the cross-school check is skipped");
    }

    console.log("\nA key that can no longer be read");
    await owner.paymentGateway.update({ where: { schoolId: school.id }, data: { secretKeyEnc: "g1.bad.bad.bad" } });
    const r6 = await attempt("10.00");
    const unreadable = await settleOnlinePayment(school.id, r6, { verify: success(r6) });
    check("an unreadable key is an error that tells the school to enter it again, and books nothing", unreadable.state === "error" && /enter it again/.test(unreadable.detail ?? "") && (await paymentsFor(r6)).length === 0);
    await owner.paymentGateway.update({ where: { schoolId: school.id }, data: { secretKeyEnc: enc } });

    console.log("\nThe webhook route, over HTTP");
    let up = false;
    try {
      up = (await fetch(BASE + "/login", { redirect: "manual", signal: AbortSignal.timeout(5000) })).status < 500;
    } catch {
      up = false;
    }
    if (!up) {
      console.log(`  --  no server at ${BASE}; the HTTP half is skipped (start the app and run this again)`);
    } else {
      const url = `${BASE}/api/paystack/webhook/${school.id}`;
      const rw = await attempt("10.00");
      const event = JSON.stringify({ event: "charge.success", data: { reference: rw, amount: 1000 } });
      const sign = (body: string, key = FAKE_SK) => createHmac("sha512", key).update(body).digest("hex");
      const post = async (path: string, body: string, signature?: string) => {
        const res = await fetch(path, { method: "POST", body, headers: signature ? { "x-paystack-signature": signature } : {}, signal: AbortSignal.timeout(60_000) });
        return { status: res.status, text: await res.text() };
      };

      check("no signature header is a 401", (await post(url, event)).status === 401);
      check("a signature of the wrong shape is a 401", (await post(url, event, "abc")).status === 401);
      check("a well-formed but wrong signature is a 401", (await post(url, event, "a".repeat(128))).status === 401);
      check("a signature made with the wrong key is a 401", (await post(url, event, sign(event, "sk_test_" + "z".repeat(20)))).status === 401);
      check("a body changed after signing is a 401", (await post(url, event.replace("1000", "1"), sign(event))).status === 401);
      check("a malformed school id is a 404 before any lookup", (await post(`${BASE}/api/paystack/webhook/..%2Fx`, event, sign(event))).status === 404);
      const noKey = other ? await post(`${BASE}/api/paystack/webhook/${other.id}`, event, sign(event)) : null;
      check("a school with no key answers exactly like a bad signature (a 401, not a 404)", noKey === null || noKey.status === 401, String(noKey?.status));
      check("none of the refused posts booked anything", (await paymentsFor(rw)).length === 0);

      const ping = JSON.stringify({ event: "transfer.success", data: {} });
      const pinged = await post(url, ping, sign(ping));
      check("a correctly signed event we do not use is acknowledged (200) and ignored", pinged.status === 200 && pinged.text === "ignored", `${pinged.status} ${pinged.text}`);
      const stranger = JSON.stringify({ event: "charge.success", data: { reference: ref() } });
      const unknown = await post(url, stranger, sign(stranger));
      check("a signed success for a reference we never made is a 200 'unknown', so Paystack stops retrying", unknown.status === 200 && unknown.text === "unknown", `${unknown.status} ${unknown.text}`);
      const unconfirmed = await post(url, event, sign(event));
      check("a signed success we cannot confirm with Paystack (a fake key) is NOT booked, and asks to be retried (503)", unconfirmed.status === 503 && (await paymentsFor(rw)).length === 0, `${unconfirmed.status} ${unconfirmed.text}`);
    }
  } finally {
    const attempts = await owner.onlinePayment.findMany({ where: { reference: { in: refs } }, select: { id: true, paymentId: true } });
    const paymentIds = (await owner.payment.findMany({ where: { providerRef: { in: refs } }, select: { id: true } })).map((x) => x.id);
    const entries = await owner.journalEntry.findMany({ where: { sourceType: "PAYMENT", sourceId: { in: paymentIds } }, select: { id: true } });
    await owner.journalLine.deleteMany({ where: { journalEntryId: { in: entries.map((e) => e.id) } } });
    await owner.journalEntry.deleteMany({ where: { id: { in: entries.map((e) => e.id) } } });
    await owner.auditLog.deleteMany({ where: { OR: [{ entity: "Payment", entityId: { in: paymentIds } }, { entity: "OnlinePayment", entityId: { in: attempts.map((x) => x.id) } }] } });
    await owner.onlinePayment.deleteMany({ where: { reference: { in: refs } } });
    await owner.payment.deleteMany({ where: { id: { in: paymentIds } } });
    for (const i of before) {
      await owner.invoice.update({
        where: { id: i.id },
        data: { amountPaid: i.amountPaid, balance: i.balance, broughtForward: i.broughtForward, total: i.total, status: i.status },
      });
    }
    if (priorGateway) {
      await owner.paymentGateway.update({ where: { schoolId: school.id }, data: { secretKeyEnc: priorGateway.secretKeyEnc, mode: priorGateway.mode, enabled: priorGateway.enabled } });
    } else {
      await owner.paymentGateway.deleteMany({ where: { schoolId: school.id } });
    }
    const left = await owner.payment.count({ where: { providerRef: { in: refs } } });
    const restored = (await owner.invoice.findMany({ where: { studentId } })).every((i) => before.find((b) => b.id === i.id)!.balance.equals(i.balance));
    check("clean-up: no probe payment is left behind and the pupil's invoices are back to their figures", left === 0 && restored);
  }
});

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
