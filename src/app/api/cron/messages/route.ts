import { createHash, timingSafeEqual } from "node:crypto";
import { releaseDueCampaigns } from "@/lib/message-dispatch";

/**
 * Releases held SMS campaigns whose five minutes are up. Called every five minutes by a GitHub Actions job
 * (`.github/workflows/release-scheduled-messages.yml`): the campaign page releases its own campaign at exactly
 * 5:00 while it is open, and this is the net for the tab that was closed.
 *
 * ⚠️ Authenticated by a shared secret, and the check comes BEFORE any work. There is no session here, so without it
 * this would be a public URL that makes the server read the database and send texts the school pays for.
 * It FAILS CLOSED: with no `CRON_SECRET` configured it answers 503 and does nothing, rather than accepting
 * anyone because there was nothing to compare against. The comparison hashes both sides first so it takes the
 * same time whatever is wrong, and `timingSafeEqual` needs equal lengths.
 *
 * The database work lives in `releaseDueCampaigns`, so this file has no query of its own (and
 * `verify:public-routes` can see that it does not read the database before the secret is checked).
 */
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sameSecret(given: string, expected: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return Response.json({ error: "The scheduled job is not configured." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!given || !sameSecret(given, expected)) {
    return Response.json({ error: "Unauthorised." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }

  const summary = await releaseDueCampaigns();
  return Response.json(summary, { headers: { "Cache-Control": "no-store" } });
}
