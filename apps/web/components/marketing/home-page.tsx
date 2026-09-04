import Link from "next/link";

import { Button } from "@/components/ui/button";
import { faqs, surfaces, whatYouGet } from "@/lib/content";
import { siteConfig } from "@/lib/config";

import { CtaSection } from "../shared/cta-section";
import { Footer } from "../shared/footer";
import { InstallDialog } from "../shared/install-dialog";
import { Navbar } from "../shared/navbar";
import { HowItWorksSection } from "./how-it-works";
import { Reveal } from "./reveal";

export function MarketingHome(): React.ReactElement {
  return (
    <div className="marketing">
      <a
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-50 focus:rounded-lg focus:bg-background focus:px-4 focus:py-2 focus:text-sm"
        href="#main"
      >
        Skip to content
      </a>
      <div className="relative z-10 rounded-b-[2rem] bg-background">
        <Navbar />
        <main className="min-h-[calc(100dvh-8rem)] pt-20" id="main">
          <section className="relative flex min-h-svh -mt-20 items-center py-20 sm:py-24">
            <div
              aria-hidden="true"
              className="hero-glow pointer-events-none absolute inset-x-0 top-0 h-full rounded-b-[2rem]"
            />
            <div className="relative mx-auto max-w-2xl px-4 text-center sm:px-6">
              <h1 className="text-balance font-display text-5xl font-light tracking-tight sm:text-6xl sm:tracking-[-0.03em]">
                An agent with its own computer.
              </h1>
              <Reveal delay={0.35}>
                <p className="mx-auto mt-4 max-w-[48ch] text-pretty text-lg text-muted-foreground">
                  Always on, one per account. It works while you are away, and hands you the mouse
                  when it gets stuck. Reach it from the web, WhatsApp, or your own CLI.
                </p>
              </Reveal>
              <Reveal delay={0.5}>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                  <Button render={<Link href={siteConfig.links.login} />} size="lg">
                    Get started
                  </Button>
                </div>
              </Reveal>
              <Reveal delay={0.6}>
                <div className="mt-4 flex items-center justify-center gap-4">
                  <a
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                    href={siteConfig.links.login}
                  >
                    Sign in
                  </a>
                  <InstallDialog className="text-sm text-muted-foreground transition-colors hover:text-foreground">
                    Add the skill
                  </InstallDialog>
                </div>
              </Reveal>
            </div>
          </section>

          <HowItWorksSection />

          <section className="py-12 sm:py-16" id="what">
            <div className="mx-auto max-w-4xl px-4 sm:px-6">
              <Reveal>
                <h2 className="font-display text-2xl font-light tracking-tight">What you get</h2>
              </Reveal>
              <ul className="mt-10 grid gap-6 sm:grid-cols-3">
                {whatYouGet.map((item, index) => (
                  <li className="rounded-2xl border border-white/[0.08] p-6" key={item.title}>
                    <Reveal delay={0.1 * (index + 1)}>
                      <h3 className="font-display text-xl font-light tracking-tight">
                        {item.title}
                      </h3>
                      <p className="mt-3 text-pretty text-sm text-white/70">{item.description}</p>
                    </Reveal>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="py-12 sm:py-16" id="reach">
            <div className="mx-auto max-w-4xl px-4 sm:px-6">
              <Reveal>
                <h2 className="font-display text-2xl font-light tracking-tight">
                  Reach it from anywhere
                </h2>
              </Reveal>
              <ul className="mt-10 grid gap-6 sm:grid-cols-2">
                {surfaces.map((item, index) => (
                  <li className="rounded-2xl border border-white/[0.08] p-6" key={item.title}>
                    <Reveal delay={0.1 * (index + 1)}>
                      <h3 className="font-display text-xl font-light tracking-tight">
                        {item.title}
                      </h3>
                      <p className="mt-3 text-pretty text-sm text-white/70">{item.description}</p>
                    </Reveal>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          <section className="py-12 sm:py-16" id="faq">
            <div className="mx-auto max-w-4xl px-4 sm:px-6">
              <Reveal>
                <h2 className="text-balance font-display text-2xl font-light tracking-tight">
                  FAQ
                </h2>
              </Reveal>
              <Reveal className="mt-10" delay={0.1}>
                <div className="divide-y divide-white/10">
                  {faqs.map((faq) => (
                    <details className="group py-4" key={faq.question}>
                      <summary className="cursor-pointer list-none font-medium transition-colors hover:text-white">
                        <span className="flex items-center justify-between gap-4">
                          {faq.question}
                          <span aria-hidden className="text-muted-foreground group-open:rotate-45">
                            +
                          </span>
                        </span>
                      </summary>
                      <p className="mt-3 text-sm text-muted-foreground">{faq.answer}</p>
                    </details>
                  ))}
                </div>
              </Reveal>
            </div>
          </section>
        </main>
      </div>
      <div className="sticky bottom-0 z-0 -mt-10 bg-night-sky pt-10">
        <CtaSection />
        <Footer />
      </div>
    </div>
  );
}
