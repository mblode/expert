import { useState } from "react";

import { pair } from "../lib/seat";
import type { StoredSeat } from "../lib/storage";

const DEFAULT_HUB = "http://127.0.0.1:8787";

/**
 * Pairing is the whole of sign-in: a setup code buys a seat token, and a seat
 * is the box owner. Nothing else here is configurable.
 */
export function PairView({ onPaired }: { onPaired: (seat: StoredSeat) => void }): React.ReactElement {
  const [hubUrl, setHubUrl] = useState(DEFAULT_HUB);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await pair(hubUrl, code.trim());
      onPaired({ hubUrl: hubUrl.trim().replace(/\/+$/u, ""), seatToken: result.token });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "pairing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form className="w-full max-w-sm space-y-5" onSubmit={submit}>
        <div>
          <h1 className="text-xl font-semibold">Computer</h1>
          <p className="mt-1 text-sm text-mute">
            Pair with the box to watch its screen and talk to Eve.
          </p>
        </div>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-mute">Hub URL</span>
          <input
            autoComplete="url"
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent"
            name="hub"
            onChange={(event) => setHubUrl(event.target.value)}
            spellCheck={false}
            value={hubUrl}
          />
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-mute">Setup code</span>
          <input
            autoFocus
            className="w-full rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
            name="code"
            onChange={(event) => setCode(event.target.value)}
            placeholder="from `npm run up`"
            spellCheck={false}
            value={code}
          />
        </label>

        {error && (
          <p className="rounded-lg border border-red-900/60 bg-red-950/50 px-3 py-2 text-sm text-red-200" role="alert">
            {error}
          </p>
        )}

        <button
          className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
          disabled={busy || !code.trim()}
          type="submit"
        >
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
    </div>
  );
}
