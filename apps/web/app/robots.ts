import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

/**
 * Index the front door, nothing behind it. The signed-in workspace, the
 * invite desks, the Bot template pages and the API are either private or
 * one-time links; each of those routes also says `noindex` for itself.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    host: siteConfig.url,
    rules: [
      {
        allow: "/",
        disallow: ["/api/", "/desk/", "/plugins/", "/bot/", "/start", "/work", "/channels/"],
        userAgent: "*",
      },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
