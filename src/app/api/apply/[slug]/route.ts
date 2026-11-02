import { clientIp } from "@/lib/rate-limit";
import { busyResponse, isBusy, publicLookup } from "@/lib/public-route";
import { MAX_BODY } from "@/lib/admissions-rules";
import { looksLikeSlug, submitPublicApplication } from "@/lib/admissions-public";

/**
 * A parent applies for a place, with no login.
 *
 * The one route that lets a stranger WRITE a row into a school's data, so it is built to refuse early and
 * explain nothing it need not:
 *
 * - JSON only, same-origin only, and a body cap, all checked before any query. A cross-site form can post
 *   text/plain but cannot post JSON without a preflight this app never answers.
 * - Everything that touches the database runs inside `publicLookup`'s budget (two at once, a short queue,
 *   the rest turned away with a 503), because the app role has four connections and a flood of public
 *   requests would otherwise queue the signed-in site behind them.
 * - A school with no form, a closed form, a lapsed school and a slug that is not a school are the SAME 404.
 *
 * Not cached, and never carries a cookie: a session on this route would change nothing and is not read.
 */
const headers = { "Cache-Control": "no-store" };
const refuse = (error: string, status: number) => Response.json({ error }, { status, headers });

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!looksLikeSlug(slug)) {
    return refuse("This application form is not available.", 404);
  }
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return refuse("Send JSON.", 415);
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return refuse("Not from this site.", 403);
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY * 2) {
    return refuse("That is too much to send.", 413);
  }
  const text = await request.text();
  if (text.length > MAX_BODY) {
    return refuse("That is too much to send.", 413);
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return refuse("That was not JSON.", 400);
  }

  const address = await clientIp();
  try {
    const outcome = await publicLookup(() => submitPublicApplication(slug, body, address));
    if (outcome.status === 200) {
      return Response.json({ ok: true, reference: outcome.reference }, { headers });
    }
    return refuse(outcome.error, outcome.status);
  } catch (error) {
    if (isBusy(error)) {
      return busyResponse();
    }
    throw error;
  }
}
