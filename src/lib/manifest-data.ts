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
 * ⚠️ The school id is IN THE URL — the manifest's as well as the icons' —
 * never read from the session. These urls are handed to the OS, not fetched
 * by the page itself, and none of those fetches can be relied on to carry a
 * cookie:
 *
 * - a browser's manifest-icon harvester and iOS's Add to Home Screen icon
 *   fetch drop cookies on exactly this kind of sub-resource request;
 * - the MANIFEST ITSELF is fetched with credentials mode "omit". The HTML
 *   spec says so for any `<link rel="manifest">` without
 *   `crossorigin="use-credentials"`, and Next only adds that attribute on
 *   Vercel preview deployments. The first per-school manifest read the session
 *   cookie, so in production it never saw one, redirected every install to the
 *   generic file, and every school's home screen showed the green "S" — while
 *   the page head, fetched normally, pointed at the right crest.
 *
 * A crest is not sensitive — it is the same mark printed on every bill — so
 * there is nothing wrong with serving it, and a manifest naming it, off an
 * explicit, public, cacheable url instead of one gated on a cookie that never
 * arrives.
 */
export function schoolIconUrls(schoolId: string, crestUrl: string | null) {
  if (!crestUrl) {
    return null;
  }
  const v = new URL(crestUrl, "http://school-os.invalid").searchParams.get("v") ?? "0";
  return {
    manifest: `/api/manifest?school=${encodeURIComponent(schoolId)}&v=${v}`,
    icon192: `/api/school-icon/${schoolId}/192?v=${v}`,
    icon512: `/api/school-icon/${schoolId}/512?v=${v}`,
    maskable512: `/api/school-icon/${schoolId}/maskable-512?v=${v}`,
    appleTouch: `/api/school-icon/${schoolId}/apple-touch?v=${v}`,
  };
}
