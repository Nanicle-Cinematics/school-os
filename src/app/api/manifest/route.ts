import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { withBypass } from "@/lib/tenant-context";
import { schoolIconUrls } from "@/lib/manifest-data";
import { homeScreenLabel } from "@/lib/home-screen-label";
import {
  busyResponse,
  isBusy,
  looksLikeSchoolId,
  MISS_CACHE_CONTROL,
  publicLookup,
} from "@/lib/public-route";

/**
 * The generic manifest, with one school's crest standing in for the mark.
 *
 * Reads `public/manifest.webmanifest` off disk rather than keeping a second
 * copy of its fields — name, description, start_url, theme colours — so this
 * can never drift from the generic one the way a hand-kept duplicate would.
 * What this route changes: `icons` (when the school has a crest) and `short_name`, the label under the icon.
 *
 * ⚠️ The school comes from `?school=`, NOT the session cookie. A browser
 * fetches a manifest with credentials mode "omit" (see `schoolIconUrls`), so
 * the cookie never arrives here in production. The first version read it,
 * found nobody, and redirected every install to the generic file — every
 * school's home-screen icon was the green "S". Public is safe for the same
 * reason the icon route is: the response says nothing but which crest a
 * school prints on its bills.
 *
 * A school that does not exist is redirected to the static file. One with no crest is served its own
 * manifest, because the label under the icon is the school's whether or not it uploaded one.
 */
export async function GET(request: Request) {
  // Redirected by hand rather than `Response.redirect`, whose headers cannot be set: this answer
  // says "no crest here" and is worth remembering (see MISS_CACHE_CONTROL in public-route.ts).
  const fallback = () =>
    new Response(null, {
      status: 307,
      headers: {
        Location: new URL("/manifest.webmanifest", request.url).toString(),
        "Cache-Control": MISS_CACHE_CONTROL,
      },
    });

  const schoolId = new URL(request.url).searchParams.get("school");
  // Refused before it costs a connection: this route is public, and the pool is four.
  if (!schoolId || !looksLikeSchoolId(schoolId)) {
    return fallback();
  }

  // No session, so no tenant context to set; the read is scoped to the one
  // school named in the url, exactly as /api/school-icon does it. Inside the
  // public budget, which keeps a flood from queueing the whole site behind it.
  let school: { crestUrl: string | null; name: string; shortName: string | null } | null;
  try {
    school = await publicLookup(() =>
      withBypass(() => prisma.school.findUnique({ where: { id: schoolId }, select: { crestUrl: true, name: true, shortName: true } })),
    );
  } catch (error) {
    if (isBusy(error)) {
      return busyResponse();
    }
    throw error;
  }
  // No such school: the generic file. A school with no crest still gets ITS manifest, for the label.
  if (!school) {
    return fallback();
  }
  const icons = schoolIconUrls(schoolId, school.crestUrl);

  const raw = await readFile(join(process.cwd(), "public", "manifest.webmanifest"), "utf8");
  const manifest = JSON.parse(raw);
  // The name under the icon is the school's short name; `name` (install prompt, splash) stays "School OS".
  manifest.short_name = homeScreenLabel(school);
  if (icons) {
    manifest.icons = [
      { src: icons.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: icons.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: icons.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ];
  }

  return Response.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      // The url carries the crest's version, so a new crest is a new url. Not
      // immutable, though: the rest of the body comes from the static file,
      // which a deploy can change under the same url.
      "Cache-Control": "public, max-age=3600",
    },
  });
}
