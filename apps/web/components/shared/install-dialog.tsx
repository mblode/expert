"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Link from "next/link";

import { siteConfig } from "@/lib/config";

export function InstallDialog({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [close, open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(siteConfig.installCommand);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <span className="inline-flex" onClick={() => setOpen(true)}>
        {children}
      </span>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <button
            aria-label="Close"
            className="absolute inset-0 bg-black/60 backdrop-blur-[10px]"
            onClick={close}
            type="button"
          />
          <div
            aria-labelledby={titleId}
            aria-modal="true"
            className="relative z-10 grid w-full max-w-lg gap-4 rounded-2xl border border-white/10 bg-background p-6 shadow-lg"
            role="dialog"
          >
            <div className="flex flex-col gap-2 text-center sm:text-left">
              <h2 className="font-display text-2xl font-light" id={titleId}>
                Get started
              </h2>
              <p className="text-sm text-muted-foreground">
                Paste this command into your terminal. Works with Claude, Codex, OpenCode, and
                Cursor. Humans sign in at hello.expert — that is install.
              </p>
            </div>
            <code className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted px-4 py-3 font-mono text-sm">
              <span className="min-w-0 overflow-x-auto whitespace-nowrap">
                <span className="text-muted-foreground">$ </span>
                {siteConfig.installCommand}
              </span>
              <button
                aria-label={copied ? "Copied" : "Copy to clipboard"}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                onClick={() => void copy()}
                type="button"
              >
                {copied ? "✓" : "⧉"}
              </button>
            </code>
            <Link
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
              href={siteConfig.links.login}
              onClick={close}
            >
              Already have an account? Sign in
            </Link>
            <button
              className="sr-only"
              onClick={close}
              ref={closeRef}
              type="button"
            >
              Close
            </button>
            <button
              aria-label="Close"
              className="absolute top-4 right-4 text-muted-foreground transition-colors hover:text-foreground"
              onClick={close}
              type="button"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </>
  );
}
