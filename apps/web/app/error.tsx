"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import { captureClientException } from "@/lib/posthog-client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  useEffect(() => {
    captureClientException(error);
  }, [error]);
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <h1 className="text-xl font-semibold">Something broke</h1>
        <p
          className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200"
          role="alert"
        >
          {error.message || "Unexpected error."}
        </p>
        <Button className="w-full" onClick={reset} size="input" type="button">
          Try again
        </Button>
      </div>
    </div>
  );
}
