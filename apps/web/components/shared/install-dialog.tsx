"use client";

import Link from "next/link";

import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { siteConfig } from "@/lib/config";

/** The trigger is a Blode Button; `children` is its label, `className` its look. */
export function InstallDialog({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <Dialog>
      <DialogTrigger render={<Button className={className} size="sm" variant="ghost" />}>
        {children}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-2xl font-light">Get started</DialogTitle>
          <DialogDescription>
            Paste this command into your terminal. Works with Claude, Codex, OpenCode, and Cursor.
            Humans sign in at hello.expert, that is install.
          </DialogDescription>
        </DialogHeader>
        <code className="flex min-w-0 items-center justify-between gap-2 rounded-lg bg-muted px-4 py-3 font-mono text-sm">
          <span className="min-w-0 overflow-x-auto whitespace-nowrap">
            <span className="text-muted-foreground">$ </span>
            {siteConfig.installCommand}
          </span>
          <CopyButton size="icon-xs" value={siteConfig.installCommand} />
        </code>
        <Link
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          href={siteConfig.links.login}
        >
          Already have an account? Sign in
        </Link>
      </DialogContent>
    </Dialog>
  );
}
