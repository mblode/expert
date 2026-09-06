import type { Metadata } from "next";

import { JsonLd } from "@/components/json-ld";
import { PageShell, proseClass } from "@/components/marketing/page-shell";
import { siteConfig } from "@/lib/config";
import { CONTACT } from "@/lib/pages";
import { breadcrumbList, CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  alternates: { canonical: "/contact" },
  description: CONTACT.description,
  title: "Contact",
};

const crumbs = [
  { href: "/", name: siteConfig.name },
  { href: "/contact", name: "Contact" },
];

export default function ContactPage(): React.ReactElement {
  return (
    <PageShell crumbs={crumbs}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@id": `${siteConfig.url}/contact#webpage`,
              "@type": "ContactPage",
              about: { "@id": `${siteConfig.url}/#organization` },
              isPartOf: { "@id": `${siteConfig.url}/#website` },
              name: CONTACT.title,
              url: `${siteConfig.url}/contact`,
            },
            breadcrumbList(crumbs),
          ],
        }}
      />
      <h1 className="font-display text-4xl font-light tracking-tight">{CONTACT.title}</h1>
      <div className={`mt-6 ${proseClass}`}>
        <p>
          <a
            className="text-foreground underline underline-offset-4"
            href={`mailto:${CONTACT_EMAIL}`}
          >
            {CONTACT_EMAIL}
          </a>
        </p>
        {CONTACT.paragraphs.map((p) => (
          <p key={p.slice(0, 32)}>{p}</p>
        ))}
        <p>
          <a
            className="text-foreground underline underline-offset-4"
            href={`${siteConfig.links.github}/issues`}
            rel="noopener noreferrer"
            target="_blank"
          >
            Open an issue on GitHub
          </a>
        </p>
      </div>
    </PageShell>
  );
}
