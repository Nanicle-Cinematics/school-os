import { requireRole } from "@/lib/auth";
import { FINANCE } from "@/lib/permissions";
import { setTenantContext } from "@/lib/tenant-context";
import { prisma } from "@/lib/prisma";

/**
 * Serve one bank slip or expense receipt.
 *
 * ⚠️ This checks the ROLE, unlike /api/school-asset, and the difference is the
 * point. A crest is on every report card and belongs to anyone who can open the
 * school; a bank slip names a family and an amount. Every parent holds a session
 * in this school, so scoping to the school alone would let any of them fetch any
 * other family's slip by id. `requireRole(FINANCE)` is the heavier path — it
 * resolves the user, their memberships and the school — and here that cost buys
 * the thing the cheap version cannot.
 *
 * RLS scopes the read to the session's school on top of that, so a guessed id
 * from another tenant returns nothing rather than someone else's paper.
 */
export async function GET(_request: Request, { params }: RouteContext<"/api/attachment/[id]">) {
  const auth = await requireRole(FINANCE);
  setTenantContext({ schoolId: auth.schoolId });

  const { id } = await params;
  const file = await prisma.fileAttachment.findUnique({
    where: { id },
    select: { bytes: true, mimeType: true, byteSize: true },
  });
  if (!file) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(file.bytes), {
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(file.byteSize),
      // private: it is one school's financial paper, and a shared cache in
      // front of this would serve it to the next school through the same proxy.
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": "inline",
    },
  });
}
