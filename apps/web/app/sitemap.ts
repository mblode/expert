import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";
import { ABOUT, CONTACT, GUIDES, PRIVACY } from "@/lib/pages";
import { HOME_LAST_MODIFIED } from "@/lib/site";

/**
 * Every indexable page, dated by its content. `/login` is `noindex` and
 * stays out. Google ignores priority and change frequency, so neither is
 * emitted; a build-time date would mark everything changed on every deploy.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const latestGuide = Math.max(
    HOME_LAST_MODIFIED.getTime(),
    ...GUIDES.map((g) => new Date(g.updated).getTime()),
  );
  return [
    { lastModified: HOME_LAST_MODIFIED, url: siteConfig.url },
    { lastModified: new Date(latestGuide), url: `${siteConfig.url}/guides` },
    ...GUIDES.map((g) => ({
      lastModified: new Date(g.updated),
      url: `${siteConfig.url}/guides/${g.slug}`,
    })),
    { lastModified: new Date(ABOUT.updated), url: `${siteConfig.url}/about` },
    { lastModified: new Date(CONTACT.updated), url: `${siteConfig.url}/contact` },
    { lastModified: new Date(PRIVACY.updated), url: `${siteConfig.url}/privacy` },
  ];
}
