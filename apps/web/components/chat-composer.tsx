import { useState } from "react";

/**
 * Enter sends, shift-Enter breaks a line. While a turn is in flight the send
 * button becomes stop, because cancelling is the only useful thing to do then.
 */
export function ChatComposer({
  busy,
  disabled,
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}): React.ReactElement {
  const [text, setText] = useState("");

  const send = () => {
    const message = text.trim();
    if (!message || busy || disabled) return;
    setText("");
    onSend(message);
  };

  return (
    <div className="flex items-end gap-2 border-t border-edge p-3">
      <textarea
        className="max-h-40 min-h-10 flex-1 resize-none rounded-lg border border-edge bg-panel px-3 py-2 text-sm outline-none focus:border-accent disabled:opacity-50"
        disabled={disabled}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            send();
          }
        }}
        placeholder="Ask Eve to do something on the box…"
        rows={1}
        value={text}
      />
      {busy ? (
        <button
          className="rounded-lg border border-edge px-3 py-2 text-sm hover:border-accent"
          onClick={onStop}
          type="button"
        >
          Stop
        </button>
      ) : (
        <button
          className="rounded-lg bg-accent px-3 py-2 text-sm font-medium text-ink disabled:opacity-50"
          disabled={disabled || !text.trim()}
          onClick={send}
          type="button"
        >
          Send
        </button>
      )}
    </div>
  );
}
