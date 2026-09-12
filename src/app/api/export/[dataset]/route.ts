import { requireAuth } from "@/lib/auth";
import { canAccess } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { prisma, tenantTransaction } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import {
  dataset as datasetSpec,
  exportFilename,
  isDatasetName,
  toCsv,
} from "@/lib/export-data";

/**
 * Hand a school its own data as a CSV.
 *
 * A route rather than a server action because this is a DOWNLOAD: the browser
 * needs `Content-Disposition`, and an action can only return values into a page.
 *
 * Three things this must get right, in order of how badly each fails:
 *
 *  1. **The tenant.** Set explicitly before any read. Under RLS alone an
 *     unscoped query returns NOTHING rather than erroring, which would hand the
 *     school an empty file that reads as "we have no students" — so
 *     `assertTenantContext` in prisma.ts refuses the query outright instead, and
 *     removing this line 500s rather than exporting a blank register. Verified
 *     by doing it: `TenantContextMissingError: No tenant context for a query on
 *     Student`. The guard is what makes the mistake loud; the line is still what
 *     makes it right.
 *  2. **The role.** An export is a bulk read of the entire school in one click,
 *     which is a different thing from opening a page — so the check is per
 *     dataset, and a 403 rather than a redirect, because a download that
 *     silently returns a login page as a .csv is worse than a refusal.
 *  3. **The audit.** Somebody taking a copy of every child and every guardian's
 *     phone number is exactly what an audit trail is for. Written BEFORE the
 *     file is handed over, so an interrupted download is still recorded.
 */

export async function GET(
  request: Request,
  { params }: { params: Promise<{ dataset: string }> },
) {
  const { dataset } = await params;
  if (!isDatasetName(dataset)) {
    return new Response("Unknown export", { status: 404 });
  }

  const auth = await requireAuth();
  const spec = datasetSpec(dataset);

  if (!canAccess(auth.roles, spec.roles)) {
    return new Response(`You do not have permission to export ${spec.label.toLowerCase()}.`, {
      status: 403,
    });
  }

  setTenantContext({ schoolId: auth.schoolId });

  const url = new URL(request.url);
  const termId = url.searchParams.get("term");

  let termLabel: string | null = null;
  if (spec.needsTerm) {
    if (!termId) {
      return new Response(`${spec.label} are exported one term at a time — choose a term.`, {
        status: 400,
      });
    }
    const term = await prisma.term.findUnique({
      where: { id: termId },
      select: { name: true, academicYear: { select: { name: true } } },
    });
    // RLS scopes this, so a term id from another school reads as missing —
    // which is the right answer to give, and the same one /results gives.
    if (!term) {
      return new Response("That term does not exist.", { status: 404 });
    }
    termLabel = `${term.name}-${term.academicYear.name}`;
  }

  const rows = await spec.load(termId);

  await tenantTransaction(auth.schoolId, (tx) =>
    writeAudit(tx, {
      schoolId: auth.schoolId,
      actorUserId: auth.userId,
      action: "data.export",
      entity: "Export",
      entityId: dataset,
      after: { dataset, rows: rows.length, termId: termId ?? null },
    }),
  );

  // The short name if the school set one, else its full name — the filename is
  // sanitised either way, so "St. Mary's R/C JHS" lands as st-mary-s-r-c-jhs.
  const filename = exportFilename(
    dataset,
    auth.schoolShortName ?? auth.schoolName,
    termLabel,
  );

  return new Response(toCsv(spec.headers, rows, spec.textColumns), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // A school's register must never sit in a shared cache, and a stale copy
      // of a register is worse than no copy.
      "Cache-Control": "no-store, private",
    },
  });
}
