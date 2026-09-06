import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

/** The public pages: the front door and the sign-in. Everything else is behind an account or a link. */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { changeFrequency: "weekly", priority: 1, url: siteConfig.url },
    { changeFrequency: "monthly", priority: 0.3, url: `${siteConfig.url}/login` },
  ];
}
