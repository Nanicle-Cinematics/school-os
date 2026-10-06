import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";
import { setTenantContext } from "@/lib/tenant-context";
import { activeSchoolId } from "@/lib/session-school";
import { schoolIconUrls } from "@/lib/manifest-data";

/**
 * The generic manifest, with one school's crest standing in for the mark.
 *
 * Reads `public/manifest.webmanifest` off disk rather than keeping a second
 * copy of its fields — name, description, start_url, theme colours — so this
 * can never drift from the generic one the way a hand-kept duplicate would.
 * The ONLY thing this route ever changes is `icons`.
 *
 * A school with no crest is redirected to the static file outright rather than
 * served an identical copy of it: one fewer thing that could drift, and the
 * static file is a normal cacheable asset while this route, reading the
 * session cookie, is never allowed to be.
 */
export async function GET(request: Request) {
  const fallback = () => Response.redirect(new URL("/manifest.webmanifest", request.url), 307);

  const schoolId = await activeSchoolId();
  if (!schoolId) {
    return fallback();
  }

  // readOnly: true because this route only reads. It skips requireAuth to stay
  // light, so it never learns the subscription, and "may not write" is the
  // answer that is correct whatever the subscription says.
  setTenantContext({ schoolId, readOnly: true });
  const school = await prisma.school.findUnique({ where: { id: schoolId }, select: { crestUrl: true } });
  const icons = schoolIconUrls(schoolId, school?.crestUrl ?? null);
  if (!icons) {
    return fallback();
  }

  const raw = await readFile(join(process.cwd(), "public", "manifest.webmanifest"), "utf8");
  const manifest = JSON.parse(raw);
  manifest.icons = [
    { src: icons.icon192, sizes: "192x192", type: "image/png", purpose: "any" },
    { src: icons.icon512, sizes: "512x512", type: "image/png", purpose: "any" },
    { src: icons.maskable512, sizes: "512x512", type: "image/png", purpose: "maskable" },
  ];

  return Response.json(manifest, {
    headers: {
      "Content-Type": "application/manifest+json",
      // Session-scoped content at a stable url: the opposite of the icons
      // above, which is exactly why it must never be cached by anything
      // shared. See public/sw.js for the same rule applied to the generic one.
      "Cache-Control": "private, no-store",
    },
  });
}
