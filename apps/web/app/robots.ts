import type { MetadataRoute } from "next";

import { siteConfig } from "@/lib/config";

/**
 * Index the front door, nothing behind it. The workspace, the invite desks,
 * the Bot template pages and the API are private or one-time links, and each
 * of those routes also says `noindex` for itself. `/login` is crawlable but
 * `noindex`: a Disallow would hide the noindex from Google.
 *
 * One rule per crawler class so the policy is legible. Training crawlers are
 * allowed on purpose: this is a small product page, blocking them buys nothing
 * enforceable and costs citations in answers that draw on training data.
 * Search and citation bots are what put the page in ChatGPT search, Claude
 * and Perplexity answers. No `Host:` line: a dropped Yandex directive that
 * auditors flag as unknown.
 */
const crawlRules = {
  allow: "/",
  disallow: ["/api/", "/desk/", "/plugins/", "/bot/", "/start", "/work", "/channels/"],
};

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", ...crawlRules },
      { userAgent: "Bingbot", ...crawlRules },
      { userAgent: ["OAI-SearchBot", "Claude-SearchBot", "PerplexityBot"], ...crawlRules },
      { userAgent: ["ChatGPT-User", "Claude-User", "Perplexity-User"], ...crawlRules },
      { userAgent: ["GPTBot", "ClaudeBot", "CCBot", "Bytespider"], ...crawlRules },
      { userAgent: ["Google-Extended", "Applebot-Extended"], ...crawlRules },
    ],
    sitemap: `${siteConfig.url}/sitemap.xml`,
  };
}
