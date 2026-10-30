import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { ATTENDANCE } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { saveRegisterFor } from "@/lib/register-save";
import { parseSyncBody, type SyncResult } from "@/lib/offline-register";

/**
 * Registers taken on a phone with no signal, sent when it is back online.
 *
 * A route and not the `saveRegister` action because a queued register outlives
 * deployments: a server action is addressed by an id baked into the page that
 * was open when the teacher pressed Save, and a deploy in between would make
 * that id unknown and every queued register fail. This URL does not change.
 *
 * It enforces exactly what the online form does, through `saveRegisterFor`
 * (form teacher of the class or the office, a date inside a term, children on
 * the roll). The one difference is the SCOPE: the phone speaks only for the
 * children it knew about, so a child it never saw keeps whatever the office
 * marked.
 *
 * Answers one result per register, so a refused day does not stop the others.
 * A signed-out caller is redirected to /login like every route here; the client
 * reads that as "sign in again" and keeps the queue.
 */
const MAX_BODY_BYTES = 256 * 1024;

export async function POST(request: Request) {
  // A cross-site form can post text/plain but cannot post JSON without a
  // preflight this app never answers, and the session cookie is SameSite=lax
  // besides. Refuse the odd case outright rather than rely on either.
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Send JSON." }, { status: 415 });
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return Response.json({ error: "Not from this site." }, { status: 403 });
  }

  const auth = await requireRole(ATTENDANCE);
  setTenantContext(auth.tenant);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "Too much to send at once." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "That was not JSON." }, { status: 400 });
  }
  const parsed = parseSyncBody(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const results: SyncResult[] = [];
  for (const item of parsed.items) {
    try {
      const result = await saveRegisterFor(auth, {
        classGroupId: item.classGroupId,
        dateRaw: item.date,
        marks: new Map(Object.entries(item.marks)),
        notes: new Map(Object.entries(item.notes)),
        scope: "listed",
        offline: { markedAt: new Date(item.markedAt).toISOString() },
      });
      results.push("error" in result ? { key: item.key, ok: false, error: result.error } : { key: item.key, ok: true, message: result.ok });
    } catch (error) {
      // A read-only school or a database blip. The marks stay on the phone.
      console.error("attendance sync failed", error);
      results.push({ key: item.key, ok: false, error: "Could not be saved just now. Try again in a moment.", retry: true });
    }
  }

  if (results.some((result) => result.ok)) {
    revalidatePath("/attendance");
    revalidatePath("/results");
  }
  return Response.json({ results });
}
