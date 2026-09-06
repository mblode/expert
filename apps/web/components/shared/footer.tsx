import Image from "next/image";
import Link from "next/link";

import { siteConfig } from "@/lib/config";

export function Footer(): React.ReactElement {
  return (
    <footer className="flex flex-col items-center justify-center gap-2 pt-16 pb-8 text-sm text-muted-foreground">
      <div className="flex items-center gap-1">
        Crafted by
        <a
          className="flex items-center gap-2 rounded-full py-1.5 pr-2.5 pl-1.5 transition-colors hover:text-foreground"
          href={siteConfig.links.author}
          rel="noopener noreferrer"
          target="_blank"
        >
          <Image
            alt="Avatar of Matthew Blode"
            className="rounded-full"
            height={20}
            src="/matthew-blode-profile.webp"
            width={20}
          />
          Matthew Blode
        </a>
      </div>
      <div className="flex flex-wrap items-center justify-center gap-3 text-muted-foreground/30">
        {[
          { href: "/guides", label: "Guides" },
          { href: "/about", label: "About" },
          { href: "/contact", label: "Contact" },
          { href: "/privacy", label: "Privacy" },
        ].map((item) => (
          <Link
            className="text-muted-foreground transition-colors hover:text-foreground"
            href={item.href}
            key={item.href}
          >
            {item.label}
          </Link>
        ))}
        <span>&middot;</span>
        <Link
          className="text-muted-foreground transition-colors hover:text-foreground"
          href={siteConfig.links.login}
        >
          Sign in
        </Link>
        <span>&middot;</span>
        <a
          className="text-muted-foreground transition-colors hover:text-foreground"
          href={siteConfig.links.github}
          rel="noopener noreferrer"
          target="_blank"
        >
          GitHub
        </a>
      </div>
    </footer>
  );
}
