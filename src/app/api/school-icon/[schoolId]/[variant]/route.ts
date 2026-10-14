import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { schoolIcon } from "@/lib/school-icon";
import {
  busyResponse,
  isBusy,
  looksLikeSchoolId,
  MISS_CACHE_CONTROL,
  publicLookup,
} from "@/lib/public-route";

/**
 * The school's own crest, sized and shaped for a home screen.
 *
 * ⚠️ Keyed by schoolId in the URL, not by session — see the note on
 * `schoolIconUrls` in manifest-data.ts for why. This is deliberately public:
 * a browser's manifest-icon harvester and iOS's Add to Home Screen icon fetch
 * do not reliably carry cookies even for a same-origin request, so a
 * session-gated version of this route simply never resolves when the OS asks
 * for it — the one caller that matters most. A crest is not sensitive data;
 * it is printed on every bill this school sends out. `withBypass` is
 * required here for the same reason `session-school.ts` needs it: there is
 * no tenant context to set without a session, and the query is already
 * scoped to the one school named in the url.
 *
 * 404s whenever there is no crest to derive from — no school, no upload —
 * rather than falling back to the generic School OS mark itself. The
 * fallback lives one layer up, in `/api/manifest` and the layout metadata
 * that decide whether to POINT here at all: a school with no crest never
 * mentions this route, so a stray 404 here always means the crest was
 * removed between the manifest being fetched and the icon being fetched, not
 * a real gap in the fallback chain.
 */

const VARIANTS: Record<string, { size: number; maskable?: boolean }> = {
  "192": { size: 192 },
  "512": { size: 512 },
  "maskable-512": { size: 512, maskable: true },
  // iOS applies its own squircle mask, exactly like the generic brand's
  // apple-touch-icon — the full-bleed maskable treatment, not the padded one.
  "apple-touch": { size: 180, maskable: true },
};

// Cached as well as refused: see MISS_CACHE_CONTROL in public-route.ts.
const NOT_FOUND = () =>
  new Response("Not found", { status: 404, headers: { "Cache-Control": MISS_CACHE_CONTROL } });

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ schoolId: string; variant: string }> },
) {
  const { schoolId, variant } = await params;
  const spec = VARIANTS[variant];
  // Both refused BEFORE anything that costs a connection: this route is public, and the pool is four.
  if (!spec || !looksLikeSchoolId(schoolId)) {
    return NOT_FOUND();
  }

  try {
    // The whole costly part (the read AND the decode below) is inside the public budget.
    return await publicLookup(async () => {
      const asset = await withBypass(() =>
        prisma.schoolAsset.findFirst({
          where: { schoolId, kind: "CREST" },
          select: { bytes: true },
        }),
      );
      if (!asset) {
        return NOT_FOUND();
      }
      return await render(asset.bytes, spec);
    });
  } catch (error) {
    if (isBusy(error)) {
      return busyResponse();
    }
    throw error;
  }
}

async function render(bytes: Uint8Array, spec: { size: number; maskable?: boolean }) {
  let png: Buffer;
  try {
    png = await schoolIcon(Buffer.from(bytes), spec.size, { maskable: spec.maskable });
  } catch {
    // An unreadable or oversized crest has no icon; the caller falls back to the
    // generic mark. 404, not a 500 that a public route then repeats on every hit.
    return NOT_FOUND();
  }

  return new Response(new Uint8Array(png), {
    headers: {
      "Content-Type": "image/png",
      "Content-Length": String(png.byteLength),
      // Public, not private: the url is minted with the crest's own version
      // token (see schoolIconUrls), so a stored copy is never the wrong
      // image, and nothing about a crest is per-viewer.
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
