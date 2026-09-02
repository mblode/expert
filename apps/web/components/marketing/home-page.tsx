import Link from "next/link";

import { faqs } from "@/lib/content";
import { siteConfig } from "@/lib/config";

import { CtaSection } from "../shared/cta-section";
import { Footer } from "../shared/footer";
import { InstallDialog } from "../shared/install-dialog";
import { Navbar } from "../shared/navbar";
import { Reveal } from "./reveal";

const howItWorks = [
  {
    step: "01",
    title: "Sign in at hello.expert",
    body: "That is install for humans. Email a one-time code. The web server attaches you to the computer. You never type a setup code.",
  },
  {
    step: "02",
    title: "Add the agent skill",
    body: `Paste \`${siteConfig.installCommand}\` into Claude, Codex, OpenCode, or Cursor. One skill from this domain.`,
  },
  {
    step: "03",
    title: "Take the seat",
    body: "Watch the desk. When you or the agent needs the box, a signed-in session can drive it through Seat RPCs. The skill cannot move the pointer without that session.",
  },
];

const who = [
  {
    role: "For you",
    description: "A standing Linux box you can watch and take over. Sign in. That is the product.",
  },
  {
    role: "For your agent",
    description: "One skill from hello.expert. After you are signed in, it uses the hub — never an invented pairing code, never a guessed setup code.",
  },
  {
    role: "For the work",
    description: "/workspace and ~/.config persist. The desk sleeps after idle and wakes when you use it. Status does not wake the guest.",
  },
];

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
                The Linux computer your AI agent uses.
              </h1>
              <Reveal delay={0.35}>
                <p className="mx-auto mt-4 max-w-[48ch] text-pretty text-lg text-muted-foreground">
                  A standing Linux computer your agents drive. Sign in at hello.expert — that is
                  install. Then add the skill so your agent can take the seat.
                </p>
              </Reveal>
              <Reveal delay={0.5}>
                <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
                  <Link
                    className="inline-flex h-12 items-center rounded-full bg-primary px-8 text-base font-medium text-primary-foreground"
                    href={siteConfig.links.login}
                  >
                    Get started
                  </Link>
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
                  <InstallDialog>
                    <button
                      className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                      type="button"
                    >
                      Add the skill
                    </button>
                  </InstallDialog>
                </div>
              </Reveal>
            </div>
          </section>

          <section className="py-12 sm:py-16" id="how">
            <div className="mx-auto max-w-4xl px-4 sm:px-6">
              <Reveal>
                <h2 className="font-display text-2xl font-light tracking-tight sm:text-4xl sm:tracking-[-0.03em]">
                  How it works
                </h2>
              </Reveal>
              <ol className="mt-10 grid gap-8 sm:grid-cols-3">
                {howItWorks.map((item, index) => (
                  <li key={item.step}>
                    <Reveal delay={0.1 * (index + 1)}>
                      <span className="font-mono text-[0.625rem] text-growth-green/70 sm:text-xs">
                        {item.step}
                      </span>
                      <h3 className="mt-1 text-lg font-semibold">{item.title}</h3>
                      <p className="mt-2 text-sm text-muted-foreground">{item.body}</p>
                    </Reveal>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section className="py-12 sm:py-16" id="who">
            <div className="mx-auto max-w-4xl px-4 sm:px-6">
              <Reveal>
                <h2 className="font-display text-2xl font-light tracking-tight">Who it&apos;s for</h2>
              </Reveal>
              <ul className="mt-10 grid gap-6 sm:grid-cols-3">
                {who.map((item, index) => (
                  <li className="rounded-2xl border border-white/[0.08] p-6" key={item.role}>
                    <Reveal delay={0.1 * (index + 1)}>
                      <h3 className="font-display text-xl font-light tracking-tight">{item.role}</h3>
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
                <h2 className="text-balance font-display text-2xl font-light tracking-tight">FAQ</h2>
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
