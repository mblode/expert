import type { Metadata } from "next";

import { JsonLd } from "@/components/json-ld";
import { PageShell, proseClass } from "@/components/marketing/page-shell";
import { siteConfig } from "@/lib/config";
import { PRIVACY } from "@/lib/pages";
import { breadcrumbList } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/privacy" },
  description: PRIVACY.description,
  title: "Privacy",
};

const crumbs = [
  { href: "/", name: siteConfig.name },
  { href: "/privacy", name: "Privacy" },
];

export default function PrivacyPage(): React.ReactElement {
  return (
    <PageShell crumbs={crumbs}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@id": `${siteConfig.url}/privacy#webpage`,
              "@type": "WebPage",
              dateModified: PRIVACY.updated,
              isPartOf: { "@id": `${siteConfig.url}/#website` },
              name: PRIVACY.title,
              url: `${siteConfig.url}/privacy`,
            },
            breadcrumbList(crumbs),
          ],
        }}
      />
      <h1 className="font-display text-4xl font-light tracking-tight">{PRIVACY.title}</h1>
      <p className={`mt-6 ${proseClass}`}>{PRIVACY.description}</p>
      {PRIVACY.sections.map((section) => (
        <section className="mt-10" key={section.title}>
          <h2 className="font-display text-2xl font-light tracking-tight">{section.title}</h2>
          <div className={`mt-3 ${proseClass}`}>
            {section.body.map((b) => (
              <p key={b.slice(0, 32)}>{b}</p>
            ))}
          </div>
        </section>
      ))}
      <p className="mt-10 text-muted-foreground text-sm">Updated {PRIVACY.updated}.</p>
    </PageShell>
  );
}
