import type { Metadata } from "next";

import { JsonLd } from "@/components/json-ld";
import { PageShell, proseClass } from "@/components/marketing/page-shell";
import { siteConfig } from "@/lib/config";
import { ABOUT } from "@/lib/pages";
import { breadcrumbList } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/about" },
  description: ABOUT.description,
  title: "About",
};

const crumbs = [
  { href: "/", name: siteConfig.name },
  { href: "/about", name: "About" },
];

export default function AboutPage(): React.ReactElement {
  return (
    <PageShell crumbs={crumbs}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@id": `${siteConfig.url}/about#webpage`,
              "@type": "AboutPage",
              about: { "@id": `${siteConfig.url}/#organization` },
              dateModified: ABOUT.updated,
              isPartOf: { "@id": `${siteConfig.url}/#website` },
              name: ABOUT.title,
              url: `${siteConfig.url}/about`,
            },
            breadcrumbList(crumbs),
          ],
        }}
      />
      <h1 className="font-display text-4xl font-light tracking-tight">{ABOUT.title}</h1>
      <div className={`mt-6 ${proseClass}`}>
        {ABOUT.paragraphs.map((p) => (
          <p key={p.slice(0, 32)}>{p}</p>
        ))}
        <p className="text-sm">Updated {ABOUT.updated}.</p>
      </div>
    </PageShell>
  );
}
