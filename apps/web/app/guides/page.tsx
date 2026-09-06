import type { Metadata } from "next";
import Link from "next/link";

import { JsonLd } from "@/components/json-ld";
import { PageShell, proseClass } from "@/components/marketing/page-shell";
import { siteConfig } from "@/lib/config";
import { GUIDES } from "@/lib/pages";
import { breadcrumbList } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/guides" },
  description:
    "Task-shaped answers about running an AI team on a computer of its own: the seat, passwords and codes, and getting a computer.",
  title: "Guides",
};

const crumbs = [
  { href: "/", name: siteConfig.name },
  { href: "/guides", name: "Guides" },
];

export default function GuidesPage(): React.ReactElement {
  return (
    <PageShell crumbs={crumbs}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@id": `${siteConfig.url}/guides#webpage`,
              "@type": "CollectionPage",
              isPartOf: { "@id": `${siteConfig.url}/#website` },
              name: "Guides",
              url: `${siteConfig.url}/guides`,
            },
            breadcrumbList(crumbs),
          ],
        }}
      />
      <h1 className="font-display text-4xl font-light tracking-tight">Guides</h1>
      <p className={`mt-6 ${proseClass}`}>
        Task-shaped answers about running an AI team on a computer of its own. Each one opens with
        the short answer and ends with the honest limit.
      </p>
      <ul className="mt-10 space-y-8">
        {GUIDES.map((guide) => (
          <li key={guide.slug}>
            <p className="font-mono text-muted-foreground text-xs uppercase">{guide.eyebrow}</p>
            <h2 className="mt-1 font-display text-2xl font-light tracking-tight">
              <Link className="hover:underline" href={`/guides/${guide.slug}`}>
                {guide.title}
              </Link>
            </h2>
            <p className="mt-2 text-muted-foreground text-sm">{guide.description}</p>
          </li>
        ))}
      </ul>
    </PageShell>
  );
}
