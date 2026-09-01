"use client";

export function ConnectError({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: () => void;
}): React.ReactElement {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-5">
        <div>
          <h1 className="text-xl font-semibold">Computer</h1>
          <p className="mt-1 text-sm text-mute">Signed in, but the web server could not attach to the box.</p>
        </div>
        <p className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">
          {message}
        </p>
        <button
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink"
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
        <button
          className="w-full rounded-lg border border-edge px-3 py-2 text-sm hover:border-accent"
          onClick={onSignOut}
          type="button"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
