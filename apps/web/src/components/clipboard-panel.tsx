import { useState } from "react";

import type { Seat } from "../lib/seat";

/**
 * The box's clipboard, both ways. It is the only reliable channel for anything
 * a person cannot type — a long token, a 2FA code pasted from a phone.
 */
export function ClipboardPanel({
  display,
  seat,
}: {
  display: number;
  seat: Seat;
}): React.ReactElement {
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const act = async (label: string, call: () => Promise<unknown>) => {
    setBusy(true);
    setNote(null);
    try {
      const result = await call();
      if (result && typeof result === "object" && "text" in result) {
        setText(String((result as { text: unknown }).text ?? ""));
      }
      setNote(label);
    } catch (cause) {
      setNote(cause instanceof Error ? cause.message : "clipboard failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-edge p-3">
      <label className="block text-xs font-medium uppercase tracking-wide text-mute" htmlFor="clip">
        Clipboard
      </label>
      <textarea
        className="h-20 w-full resize-none rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        id="clip"
        onChange={(event) => setText(event.target.value)}
        placeholder="Read from the box, or paste something in and send it."
        value={text}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50"
          disabled={busy}
          onClick={() => void act("Read from the box.", () => seat.clipboardGet(display))}
          type="button"
        >
          Read
        </button>
        <button
          className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50"
          disabled={busy || !text}
          onClick={() => void act("Sent to the box.", () => seat.clipboardSet(text, display))}
          type="button"
        >
          Send
        </button>
        {note && <span className="text-xs text-mute">{note}</span>}
      </div>
    </div>
  );
}
