import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/auth";
import { TIMETABLE_EDIT } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { applyStandardDay, replacePeriods, type PeriodsPost } from "@/lib/timetable-periods";
import { MAX_PERIODS } from "@/lib/timetable-rules";

/**
 * Set the school day. `{ standard: true }` gives a school with no day the
 * standard one; `{ rows: [...] }` replaces the day with the list posted.
 *
 * A route for the reason /api/timetable/slot is one: the form on the setup page
 * must keep what was typed when a row is refused, and a form action resets it.
 */
const MAX_BODY_BYTES = 16 * 1024;

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
  let body: { standard?: unknown; rows?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "That was not JSON." }, { status: 400 });
  }

  try {
    let result;
    if (body && body.standard === true) {
      result = await applyStandardDay(auth);
    } else {
      const rows = body?.rows;
      if (!Array.isArray(rows) || rows.length > MAX_PERIODS + 5) {
        return Response.json({ error: "Expected a list of periods." }, { status: 400 });
      }
      const clean: PeriodsPost[] = [];
      for (const row of rows) {
        const r = row as Record<string, unknown>;
        if (
          !r ||
          typeof r.label !== "string" ||
          typeof r.startTime !== "string" ||
          typeof r.endTime !== "string" ||
          typeof r.isBreak !== "boolean" ||
          (r.id !== undefined && r.id !== null && (typeof r.id !== "string" || r.id.length > 64))
        ) {
          return Response.json({ error: "A period was malformed." }, { status: 400 });
        }
        clean.push({
          id: typeof r.id === "string" && r.id ? r.id : undefined,
          label: r.label.slice(0, 80),
          startTime: r.startTime.slice(0, 8),
          endTime: r.endTime.slice(0, 8),
          isBreak: r.isBreak,
        });
      }
      result = await replacePeriods(auth, clean);
    }
    if ("ok" in result) {
      revalidatePath("/timetable");
      revalidatePath("/timetable/periods");
      return Response.json(result);
    }
    return Response.json(result, { status: 422 });
  } catch (error) {
    console.error("timetable periods failed", error);
    return Response.json({ error: "Could not be saved just now. Try again in a moment." }, { status: 503 });
  }
}
