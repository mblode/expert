"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";

export function ConnectError({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => Promise<boolean>;
  onSignOut: () => void;
}): React.ReactElement {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const retrying = useRef(false);

  async function retry() {
    if (retrying.current) return;
    retrying.current = true;
    setPending(true);
    setFailed(false);
    try {
      setFailed(!(await onRetry()));
    } catch {
      setFailed(true);
    } finally {
      retrying.current = false;
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">You’re signed in</p>
          <h1 className="text-2xl font-semibold tracking-tight">Let’s reconnect your workspace</h1>
          <p className="text-sm text-muted-foreground">
            We couldn’t connect to your computer. Try connecting again; you don’t need another
            sign-in code.
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <Button className="w-full" loading={pending} onClick={retry} size="input" type="button">
            {pending ? "Connecting…" : "Reconnect"}
          </Button>
          <output aria-live="polite" className="text-sm text-muted-foreground">
            {pending
              ? "This may take a moment."
              : failed
                ? "Still unable to connect. Wait a moment, then try again."
                : "Your sign-in is saved."}
          </output>
        </div>
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer py-2">Connection details</summary>
          <p className="pt-2 break-words">{message}</p>
        </details>
        <Button
          className="self-start"
          disabled={pending}
          onClick={onSignOut}
          type="button"
          variant="link"
        >
          Sign out
        </Button>
      </div>
    </main>
  );
}
