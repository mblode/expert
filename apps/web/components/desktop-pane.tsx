import { useState } from "react";

import type { BoxStatus, Screen, Seat, SeatState } from "../lib/seat";
import { screenSrc } from "../lib/seat";
import { useSeatInput } from "../lib/use-seat-input";
import { ClipboardPanel } from "./clipboard-panel";

const STATE_LABEL: Record<SeatState, string> = {
  AGENT: "Eve has the seat",
  WAITING: "Eve needs you",
  HUMAN: "You have the seat",
};

const STATE_DOT: Record<SeatState, string> = {
  AGENT: "bg-emerald-400",
  WAITING: "bg-amber-400",
  HUMAN: "bg-sky-400",
};

/**
 * The box's screen, and the only way to touch it.
 *
 * The stream itself is view-only — the X server refuses RFB input — so the
 * overlay over the iframe translates real input into Seat RPCs. It is live only
 * while the seat is `WAITING` or `HUMAN`; while the agent holds the seat the
 * hub rejects human input outright, and this shows pixels only.
 */
export function DesktopPane({
  display,
  onDisplayChange,
  onStatus,
  seat,
  status,
}: {
  display: number;
  onDisplayChange: (display: number) => void;
  onStatus: (status: BoxStatus) => void;
  seat: Seat;
  status: BoxStatus | undefined;
}): React.ReactElement {
  const [showClipboard, setShowClipboard] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [busy, setBusy] = useState(false);

  const screen: Screen | undefined =
    status?.screens.find((candidate) => candidate.display === display) ?? status?.screens[0];
  const state = screen?.state ?? status?.state ?? "AGENT";
  const controllable = state !== "AGENT";
  const desk = status?.display ?? { width: 1280, height: 800 };
  const elsewhereWaiting = status?.screens.find(
    (candidate) => candidate.state === "WAITING" && candidate.display !== screen?.display,
  );

  const input = useSeatInput(seat, display, controllable, desk);

  const presence = async (present: boolean) => {
    setBusy(true);
    try {
      onStatus(await seat.setPresence(present, display));
    } catch {
      // The next poll re-reads the truth; a failed toggle needs no banner.
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2">
        {status && status.screens.length > 1 ? (
          <select
            aria-label="Screen"
            className="rounded-md border border-edge bg-panel px-2 py-1 text-xs outline-none focus:border-accent"
            onChange={(event) => onDisplayChange(Number(event.target.value))}
            value={display}
          >
            {status.screens.map((candidate) => (
              <option key={candidate.display} value={candidate.display}>
                {candidate.bot_id} · screen {candidate.display}
                {candidate.state === "WAITING" ? " · needs you" : ""}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-mute">{screen?.bot_id ?? "box"}</span>
        )}

        <span className="flex items-center gap-1.5 text-xs text-mute">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          {STATE_LABEL[state]}
        </span>

        <div className="ml-auto flex items-center gap-2">
          {/* Only offered while the seat is yours: the hub refuses typing
              otherwise, so the bar would be a field that eats what you write. */}
          {controllable && (
            <button
              aria-expanded={showKeyboard}
              className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
              onClick={() => setShowKeyboard((open) => !open)}
              type="button"
            >
              Keyboard
            </button>
          )}
          <button
            aria-expanded={showClipboard}
            className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
            onClick={() => setShowClipboard((open) => !open)}
            type="button"
          >
            Clipboard
          </button>
          {controllable ? (
            <button
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-ink disabled:opacity-50"
              disabled={busy}
              onClick={() => void presence(false)}
              type="button"
            >
              I&apos;m done
            </button>
          ) : (
            // Without this the pane is silently dead: you move the mouse over
            // someone else's desktop and nothing happens, with no way to ask
            // for it. Waiting to be offered the seat is not how a person
            // takes over a machine that is going wrong.
            <button
              className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent disabled:opacity-50"
              disabled={busy}
              onClick={() => void presence(true)}
              type="button"
            >
              Take the seat
            </button>
          )}
        </div>
      </header>

      {state === "WAITING" && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm">
          <span className="font-medium text-amber-200">Eve needs you — take the seat</span>
          <button
            className="rounded-md bg-amber-400 px-2.5 py-1 text-xs font-medium text-ink disabled:opacity-50"
            disabled={busy}
            onClick={() => void presence(true)}
            type="button"
          >
            Take the seat
          </button>
        </div>
      )}

      {/* A screen you are not looking at can be the one asking for you. */}
      {elsewhereWaiting && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-amber-200">
            {elsewhereWaiting.bot_id} needs you on screen {elsewhereWaiting.display}
          </span>
          <button
            className="rounded-md border border-amber-500/60 px-2.5 py-1 text-xs hover:border-amber-300"
            onClick={() => onDisplayChange(elsewhereWaiting.display)}
            type="button"
          >
            Switch
          </button>
        </div>
      )}

      {input.error && (
        <p className="border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-200" role="alert">
          {input.error}
        </p>
      )}

      <div className="flex min-h-0 flex-1 items-center justify-center bg-black p-3">
        {/* Letterboxed to the box's own aspect so the overlay's CSS pixels map
            cleanly onto its screen. */}
        <div
          className="relative w-full max-w-full"
          style={{ aspectRatio: `${desk.width} / ${desk.height}`, maxHeight: "100%" }}
        >
          {screen ? (
            <>
              <iframe
                className="absolute inset-0 size-full rounded-lg border border-edge bg-black"
                key={screen.vnc_url}
                src={screenSrc(seat.hubUrl, screen.vnc_url)}
                title={`${screen.bot_id} screen`}
              />
              <div
                aria-label="Take over the screen"
                // `touch-pinch-zoom` keeps one finger for the box — no pan, no
                // double-tap zoom — while leaving two fingers to magnify a
                // 1280×800 desk squeezed onto a phone. `select-none` stops the
                // long-press selection callout from eating a held click.
                className={`absolute inset-0 touch-pinch-zoom select-none rounded-lg outline-none ${
                  controllable ? "cursor-none focus-visible:ring-2 focus-visible:ring-accent" : "pointer-events-none"
                }`}
                role="application"
                tabIndex={controllable ? 0 : -1}
                {...input.handlers}
              />
              {/* The cursor you steer. The box's own cursor is in the video a
                  round trip behind, so this one is drawn here and moved on
                  mousemove; the box follows. */}
              {controllable && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 opacity-0 transition-opacity"
                  ref={input.cursorRef}
                  style={{ left: 0, top: 0 }}
                >
                  <svg
                    className="-translate-x-px -translate-y-px drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                    fill="none"
                    height="20"
                    viewBox="0 0 12 19"
                    width="13"
                  >
                    <path d="M1 1.5v14l3.2-3.4h5.3L1 1.5z" fill="white" stroke="black" strokeWidth="1.2" />
                  </svg>
                </div>
              )}
            </>
          ) : (
            <p className="absolute inset-0 grid place-items-center text-sm text-mute">Connecting…</p>
          )}
        </div>
      </div>

      <p className="px-3 pb-2 text-xs text-mute">
        {controllable
          ? "Point where you want the cursor and the box follows. Type here, or open Keyboard on a phone; Backspace and the arrow keys do not go through."
          : "View only while Eve is working. Take the seat to drive it yourself, or wait for it to ask."}
      </p>

      {controllable && showKeyboard && <KeyboardBar onSend={input.send} />}
      {showClipboard && <ClipboardPanel display={display} seat={seat} />}
    </section>
  );
}

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
function KeyboardBar({ onSend }: { onSend: (text: string) => void }): React.ReactElement {
  const [text, setText] = useState("");

  const send = (suffix: string) => {
    if (!text && !suffix) return;
    setText("");
    onSend(text + suffix);
  };

  return (
    <div className="flex items-center gap-2 border-t border-edge p-3">
      <input
        aria-label="Type into the box"
        // iOS rewrites what a thumb types — capitals, corrections, curly quotes
        // for straight ones — and the box would run the rewrite, not the
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
          if (event.key !== "Enter") return;
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
