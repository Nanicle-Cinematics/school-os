import "server-only";

/**
 * Home-screen icon URLs for one school's crest, or null if it has none.
 *
 * Reuses the crest's OWN version token rather than minting a new one: a crest
 * is re-uploaded under the same `crestUrl` shape — `?v=<timestamp>` set the
 * moment `uploadSchoolAsset` writes the row — so borrowing it here means a new
 * crest changes the icon URLs for free, with no second invalidation channel to
 * keep in step with the first.
 */
export function schoolIconUrls(crestUrl: string | null) {
  if (!crestUrl) {
    return null;
  }
  const v = new URL(crestUrl, "http://school-os.invalid").searchParams.get("v") ?? "0";
  return {
    icon192: `/api/school-icon/192?v=${v}`,
    icon512: `/api/school-icon/512?v=${v}`,
    maskable512: `/api/school-icon/maskable-512?v=${v}`,
    appleTouch: `/api/school-icon/apple-touch?v=${v}`,
  };
}
