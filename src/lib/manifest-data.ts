import "server-only";

/**
 * Home-screen icon URLs for one school's crest, or null if it has none.
 *
 * Reuses the crest's OWN version token rather than minting a new one: a crest
 * is re-uploaded under the same `crestUrl` shape — `?v=<timestamp>` set the
 * moment `uploadSchoolAsset` writes the row — so borrowing it here means a new
 * crest changes the icon URLs for free, with no second invalidation channel to
 * keep in step with the first.
 *
 * ⚠️ The school id is IN THE URL, not read from the session the way
 * `/api/manifest` is. These urls are handed to the OS, not fetched by the
 * page itself — a browser's manifest-icon harvester and iOS's Add to Home
 * Screen icon fetch are well documented to drop cookies on exactly this kind
 * of sub-resource request, even same-origin. A session-gated icon url simply
 * never resolves in that context: the manifest JSON itself (fetched as a
 * normal `<link rel="manifest">`) carries cookies fine and reports the right
 * crest, but every one of its `icons[].src` entries 404'd silently, and the
 * OS fell back to its own generated mark — which is indistinguishable from
 * this app's generic one at a glance. A crest is not sensitive — it is the
 * same mark printed on every bill — so there is nothing wrong with serving it
 * off an explicit, public, cacheable url instead of one gated on a cookie
 * that may never arrive.
 */
export function schoolIconUrls(schoolId: string, crestUrl: string | null) {
  if (!crestUrl) {
    return null;
  }
  const v = new URL(crestUrl, "http://school-os.invalid").searchParams.get("v") ?? "0";
  return {
    icon192: `/api/school-icon/${schoolId}/192?v=${v}`,
    icon512: `/api/school-icon/${schoolId}/512?v=${v}`,
    maskable512: `/api/school-icon/${schoolId}/maskable-512?v=${v}`,
    appleTouch: `/api/school-icon/${schoolId}/apple-touch?v=${v}`,
  };
}
