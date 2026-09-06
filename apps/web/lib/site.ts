import { siteConfig } from "./config";

/**
 * The entities every page's structured data refers to, defined once with
 * stable ids so search engines resolve one graph rather than a snippet per
 * page. A rename happens here and nowhere else.
 */
const organizationId = `${siteConfig.url}/#organization`;
const websiteId = `${siteConfig.url}/#website`;
const personId = `${siteConfig.url}/#person`;

export const AUTHOR = {
  name: "Matthew Blode",
  sameAs: ["https://github.com/mblode"],
  url: siteConfig.links.author,
} as const;

/** The date the front door's copy last changed: `lib/content.ts` and the marketing components. Move it when they move. */
export const HOME_LAST_MODIFIED = new Date("2026-09-05");

export function siteGraph(): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@id": organizationId,
        "@type": "Organization",
        // What people type: Search Console shows the brand searched as "hello
        // expert" and its run-together forms, with the site not yet tied to it.
        alternateName: ["Hello Expert", "hello.expert"],
        founder: { "@id": personId },
        name: siteConfig.name,
        sameAs: [siteConfig.links.github],
        url: siteConfig.url,
      },
      {
        "@id": websiteId,
        "@type": "WebSite",
        alternateName: ["Hello Expert", "hello.expert"],
        description: siteConfig.description,
        name: siteConfig.name,
        publisher: { "@id": organizationId },
        url: siteConfig.url,
      },
      {
        "@id": personId,
        "@type": "Person",
        name: AUTHOR.name,
        sameAs: [...AUTHOR.sameAs],
        url: AUTHOR.url,
        worksFor: { "@id": organizationId },
      },
    ],
  };
}
