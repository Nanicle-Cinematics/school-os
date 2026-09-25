import type { MetadataRoute } from "next";

/**
 * One entry, because the marketing page is the only public one — see
 * robots.ts for why everything past it is disallowed rather than listed here
 * and then blocked anyway.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_URL ?? "https://www.schoolosafrica.com";
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
