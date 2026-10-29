import { prisma } from "@/lib/prisma";
import { runWithTenantContext } from "@/lib/tenant-context";
import { decryptGatewaySecret } from "@/lib/gateway-crypto";
import { looksLikeSignature, signatureMatches } from "@/lib/paystack";
import { settleOnlinePayment } from "@/lib/online-payment-engine";
import { busyResponse, isBusy, looksLikeSchoolId, publicLookup } from "@/lib/public-route";

/**
 * Paystack tells us a parent has paid.
 *
 * This is the one route that books money with NO session, so it is built around trusting nothing:
 *
 * - It is keyed by the school in the URL, because Paystack signs with the school's own secret key and
 *   we cannot know which key to check until we know which school. The URL is therefore not a secret
 *   and not an authority: it only chooses the key the signature must match.
 * - The body is only believed after its HMAC-SHA512 matches, over the RAW bytes (a re-serialised
 *   JSON would not match). Even then it only supplies a REFERENCE. The amount, the pupil and the
 *   outcome all come from our own row and from asking Paystack again (`settleOnlinePayment`).
 * - It is public and costs a database lookup, so it spends the same budget as the other public
 *   routes (`publicLookup`), and a malformed request is turned away before any query. A burst
 *   past the budget gets a 503 and Paystack retries it later, which is exactly what it does anyway.
 *
 * Answers: 200 once there is nothing more to do (booked, already booked, not ours, a mismatch that a
 * person must look at), 5xx when trying again could help (Paystack unreachable, still pending).
 * A bad signature and a school with no key are the SAME 401, so this cannot be used to ask which
 * schools take payments online.
 */
const MAX_BODY = 64 * 1024;

const unauthorized = () => new Response("Unauthorized", { status: 401, headers: { "Cache-Control": "no-store" } });
const ok = (body = "ok") => new Response(body, { status: 200, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ schoolId: string }> }) {
  const { schoolId } = await params;
  const signature = request.headers.get("x-paystack-signature");

  // Refused before the budget or any query: this route is public, and the pool is four.
  if (!looksLikeSchoolId(schoolId)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  if (!looksLikeSignature(signature)) {
    return unauthorized();
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY) {
    return new Response("Too large", { status: 413 });
  }
  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY) {
    return new Response("Too large", { status: 413 });
  }

  try {
    return await publicLookup(async () => {
      // `await` INSIDE the scope: a Prisma promise is lazy, and returned un-awaited it would run after the
      // tenant context had exited and be refused (see runAsync in tenant-context.ts).
      const gateway = await runWithTenantContext({ schoolId }, async () =>
        await prisma.paymentGateway.findUnique({ where: { schoolId }, select: { secretKeyEnc: true } }),
      );
      if (!gateway?.secretKeyEnc) {
        return unauthorized();
      }

      let secretKey: string;
      try {
        secretKey = decryptGatewaySecret(gateway.secretKeyEnc);
      } catch {
        return unauthorized();
      }
      if (!signatureMatches(rawBody, signature, secretKey)) {
        return unauthorized();
      }

      let event: { event?: unknown; data?: { reference?: unknown } };
      try {
        event = JSON.parse(rawBody);
      } catch {
        return ok("ignored");
      }
      // Only a successful charge is of interest; every other event is acknowledged so it is not retried.
      if (event.event !== "charge.success" || typeof event.data?.reference !== "string") {
        return ok("ignored");
      }

      const result = await settleOnlinePayment(schoolId, event.data.reference);
      if (result.state === "pending" || result.state === "error") {
        return new Response(result.state, { status: 503, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
      }
      return ok(result.state);
    });
  } catch (error) {
    if (isBusy(error)) {
      return busyResponse();
    }
    throw error;
  }
}
