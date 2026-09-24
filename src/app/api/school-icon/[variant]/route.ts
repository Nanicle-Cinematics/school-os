import { activeSchoolId } from "@/lib/session-school";
import { schoolIcon } from "@/lib/school-icon";
import { prisma } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";

/**
 * The school's own crest, sized and shaped for a home screen.
 *
 * 404s whenever there is no crest to derive from — no session, no school, no
 * upload — rather than falling back to the generic School OS mark itself. The
 * fallback lives one layer up, in `/api/manifest` and the layout metadata that
 * decide whether to POINT here at all: a school with no crest never mentions
 * this route, so a stray 404 here always means the crest was removed between
 * the manifest being fetched and the icon being fetched, not a real gap in the
 * fallback chain.
 */

const VARIANTS: Record<string, { size: number; maskable?: boolean }> = {
  "192": { size: 192 },
  "512": { size: 512 },
  "maskable-512": { size: 512, maskable: true },
  // iOS applies its own squircle mask, exactly like the generic brand's
  // apple-touch-icon — the full-bleed maskable treatment, not the padded one.
  "apple-touch": { size: 180, maskable: true },
};

const NOT_FOUND = () => new Response("Not found", { status: 404 });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ variant: string }> },
) {
  const { variant } = await params;
  const spec = VARIANTS[variant];
  if (!spec) {
    return NOT_FOUND();
  }

  const schoolId = await activeSchoolId();
  if (!schoolId) {
    return NOT_FOUND();
  }

  setTenantContext({ schoolId });

  const asset = await prisma.schoolAsset.findFirst({
    where: { schoolId, kind: "CREST" },
    select: { bytes: true },
  });
  if (!asset) {
    return NOT_FOUND();
  }

  const png = await schoolIcon(Buffer.from(asset.bytes), spec.size, { maskable: spec.maskable });

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      // The URL is minted with the crest's own version token — see
      // buildSchoolIcons in src/lib/manifest-data.ts — so a stored copy is
      // never the wrong image.
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
}
