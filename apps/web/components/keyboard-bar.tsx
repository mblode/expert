import { useState } from "react";

/**
 * A phone cannot type into the pane the way a laptop does: iOS raises the soft
 * keyboard for a focused form field and for nothing else, and the overlay that
 * catches keystrokes is a `role="application"` div. So typing gets a real one.
 *
 * It composes a line and sends it whole rather than forwarding each keystroke,
 * because `Seat.Type` is a paste: once a character is on the box nothing here
 * can take it back, and Backspace does not go through. Seeing the line before
 * it leaves is the only place a thumbed typo can still be fixed.
 */
export function KeyboardBar({ onSend }: { onSend: (text: string) => void }): React.ReactElement {
  const [text, setText] = useState("");

  const send = (suffix: string) => {
    if (!text && !suffix) {
      return;
    }
    setText("");
    onSend(text + suffix);
  };

  return (
    <div className="flex items-center gap-2 border-t border-edge p-3">
      <input
        aria-label="Type into the box"
        // iOS rewrites what a thumb types: capitals, corrections, curly quotes
        // for straight ones, and the box would run the rewrite, not the
        // command. These are the attributes that turn all of it off.
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        // Mounting is the gesture that asked for the keyboard, and iOS only
        // raises it inside one.
        autoFocus
        className="min-w-0 flex-1 rounded-lg border border-edge bg-panel px-3 py-2 font-mono text-sm outline-none focus:border-accent"
        enterKeyHint="send"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") {
            return;
          }
          event.preventDefault();
          // Return goes to the box with the line: the reason to type into a
          // terminal from a phone is to run the thing you typed.
          send("\n");
        }}
        placeholder="Type into the box…"
        spellCheck={false}
        value={text}
      />
      <button
        className="rounded-lg border border-edge px-3 py-2 text-sm hover:border-accent disabled:opacity-50"
        disabled={!text}
        onClick={() => send("")}
        type="button"
      >
        Send
      </button>
    </div>
  );
}
