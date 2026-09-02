"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { siteConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

export function Navbar(): React.ReactElement {
  const [isScrolled, setIsScrolled] = useState(false);

  useEffect(() => {
    let ticking = false;
    const handleScroll = () => {
      if (ticking) {
        return;
      }
      ticking = true;
      requestAnimationFrame(() => {
        setIsScrolled(window.scrollY > 50);
        ticking = false;
      });
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <header className="fixed top-3 right-0 left-0 z-30 flex justify-center px-4">
      <nav
        aria-label="Main"
        className={cn(
          "flex w-full max-w-2xl items-center justify-between rounded-full bg-black/20 py-2.5 pr-[10px] pl-5 backdrop-blur-[20px] transition-[background-color] duration-300",
          isScrolled && "bg-black/30",
        )}
      >
        <Link
          aria-label="Homepage"
          className="flex items-center font-display font-semibold tracking-[-0.02em]"
          href="/"
        >
          {siteConfig.name}
        </Link>
        <div className="flex items-center gap-4">
          <Link
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            href={siteConfig.links.login}
          >
            Sign in
          </Link>
          <Button render={<Link href={siteConfig.links.login} />} size="xs">
            Get started
          </Button>
        </div>
      </nav>
    </header>
  );
}
