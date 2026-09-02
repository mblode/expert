"use client";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <h1 className="text-xl font-semibold">Something broke</h1>
        <p className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">
          {error.message || "Unexpected error."}
        </p>
        <button
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink"
          onClick={reset}
          type="button"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
