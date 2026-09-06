import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";
import { HOME_LAST_MODIFIED } from "@/lib/site";

/**
 * The one public page. `/login` is `noindex` and stays out. Google ignores
 * priority and change frequency, and a build-time `lastModified` would mark
 * the page changed on every deploy, so the date is the copy's, kept by hand.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [{ lastModified: HOME_LAST_MODIFIED, url: siteConfig.url }];
}
