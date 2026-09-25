import type { MetadataRoute } from "next";

/**
 * Almost everything here is a signed-in, tenant-scoped screen — a dashboard,
 * a mark sheet, a family's invoices. None of that belongs in a search result,
 * and RLS already refuses a crawler the data even if it tried. This just
 * keeps Google from spending its crawl budget on login walls and redirect
 * chains, and from ever showing one in a result snippet.
 *
 * `/$` matches the root path exactly — the one page meant to be found.
 */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.APP_URL ?? "https://www.schoolosafrica.com";
  return {
    rules: [{ userAgent: "*", allow: "/$", disallow: "/" }],
    sitemap: `${base}/sitemap.xml`,
  };
}
