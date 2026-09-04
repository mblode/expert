import Link from "next/link";

import { Button } from "@/components/ui/button";
import { siteConfig } from "@/lib/config";

export function CtaSection(): React.ReactElement {
  return (
    <section className="relative pt-20 pb-12 text-center sm:pt-26 sm:pb-16" id="install">
      <h2 className="mx-auto max-w-[20ch] text-balance font-display text-4xl font-light tracking-tight text-white sm:text-5xl sm:tracking-[-0.03em]">
        Your team. Your computer. Anywhere.
      </h2>
      <div className="relative mt-8 flex justify-center">
        <Button render={<Link href={siteConfig.links.login} />} size="lg">
          Get started
        </Button>
      </div>
      <div className="relative mt-4 flex justify-center">
        <Link
          className="text-sm text-white/70 transition-colors hover:text-white"
          href={siteConfig.links.login}
        >
          Sign in
        </Link>
      </div>
    </section>
  );
}
