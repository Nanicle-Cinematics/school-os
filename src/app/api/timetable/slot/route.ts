import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { TIMETABLE_EDIT } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { placeLesson } from "@/lib/timetable-engine";
import { parseSlotRequest } from "@/lib/timetable-rules";

/**
 * Put one lesson on the timetable, or take it off.
 *
 * A route rather than a server action because the grid places lessons one cell
 * at a time from a click and needs to hand the answer back to that cell (kept,
 * or put back with the reason). An action behind a form resets the form when it
 * returns; a refusal that wiped the other thirty cells would be a bad way to say
 * "that teacher is busy".
 *
 * Head teacher and proprietor only (`TIMETABLE_EDIT`). A refusal is a 422 with
 * the words to show; a signed-out caller is redirected like every route here.
 */
const MAX_BODY_BYTES = 4 * 1024;

export async function POST(request: Request) {
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) {
    return Response.json({ error: "Send JSON." }, { status: 415 });
  }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") {
    return Response.json({ error: "Not from this site." }, { status: 403 });
  }

  const auth = await requireRole(TIMETABLE_EDIT);
  setTenantContext(auth.tenant);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return Response.json({ error: "That is too much to send." }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "That was not JSON." }, { status: 400 });
  }
  const parsed = parseSlotRequest(body);
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  try {
    const result = await placeLesson(auth, parsed.value);
    if ("error" in result) {
      return Response.json({ error: result.error }, { status: 422 });
    }
    revalidatePath("/timetable");
    return Response.json(result);
  } catch (error) {
    // A read-only school (its subscription lapsed) refuses the write; so does a database blip.
    console.error("timetable slot failed", error);
    return Response.json({ error: "Could not be saved just now. Try again in a moment." }, { status: 503 });
  }
}
