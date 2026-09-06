import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { JsonLd } from "@/components/json-ld";
import { PageShell, proseClass } from "@/components/marketing/page-shell";
import { siteConfig } from "@/lib/config";
import { GUIDES, guideBySlug } from "@/lib/pages";
import { AUTHOR, breadcrumbList } from "@/lib/site";

export function generateStaticParams(): { slug: string }[] {
  return GUIDES.map((g) => ({ slug: g.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) {
    return {};
  }
  return {
    alternates: { canonical: `/guides/${guide.slug}` },
    description: guide.description,
    title: guide.metaTitle,
  };
}

export default async function GuidePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactElement> {
  const { slug } = await params;
  const guide = guideBySlug(slug);
  if (!guide) {
    notFound();
  }
  const url = `${siteConfig.url}/guides/${guide.slug}`;
  const crumbs = [
    { href: "/", name: siteConfig.name },
    { href: "/guides", name: "Guides" },
    { href: `/guides/${guide.slug}`, name: guide.title },
  ];
  return (
    <PageShell crumbs={crumbs}>
      <JsonLd
        data={{
          "@context": "https://schema.org",
          "@graph": [
            {
              "@id": url,
              "@type": "TechArticle",
              author: { "@id": `${siteConfig.url}/#person` },
              dateModified: guide.updated,
              datePublished: guide.published,
              description: guide.description,
              headline: guide.title,
              isPartOf: { "@id": `${siteConfig.url}/#website` },
              mainEntityOfPage: url,
              publisher: { "@id": `${siteConfig.url}/#organization` },
            },
            breadcrumbList(crumbs),
          ],
        }}
      />
      <article>
        <p className="font-mono text-muted-foreground text-xs uppercase">{guide.eyebrow}</p>
        <h1 className="mt-2 font-display text-4xl font-light tracking-tight">{guide.title}</h1>
        <p className="mt-3 text-muted-foreground text-sm">
          Last updated {guide.updated} · {AUTHOR.name}
        </p>

        <section className="mt-8">
          <h2 className="font-display text-2xl font-light tracking-tight">The short answer</h2>
          <p className={`mt-3 ${proseClass}`}>{guide.shortAnswer}</p>
        </section>

        <section className="mt-8">
          <h2 className="font-display text-2xl font-light tracking-tight">Key takeaways</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-muted-foreground">
            {guide.takeaways.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </section>

        {guide.steps.map((step, index) => (
          <section className="mt-8" key={step.title}>
            <p className="font-mono text-muted-foreground text-xs uppercase">Step {index + 1}</p>
            <h2 className="mt-1 font-display text-2xl font-light tracking-tight">{step.title}</h2>
            <div className={`mt-3 ${proseClass}`}>
              {step.body.map((b) => (
                <p key={b.slice(0, 32)}>{b}</p>
              ))}
            </div>
          </section>
        ))}

        <section className="mt-8">
          <h2 className="font-display text-2xl font-light tracking-tight">The limit</h2>
          <p className={`mt-3 ${proseClass}`}>{guide.limits}</p>
        </section>

        <section className="mt-8">
          <h2 className="font-display text-2xl font-light tracking-tight">
            Frequently asked questions
          </h2>
          {guide.faqs.map((faq) => (
            <div className="mt-5" key={faq.question}>
              <h3 className="font-medium text-foreground">{faq.question}</h3>
              <p className="mt-1 text-muted-foreground">{faq.answer}</p>
            </div>
          ))}
        </section>
      </article>
    </PageShell>
  );
}
