import { useState } from "react";

import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import type { BoxStatus, Screen, Seat, SeatState } from "../lib/seat";
import { pixelUrlFresh } from "../lib/seat";
import { useSeatInput } from "../lib/use-seat-input";
import { ClipboardPanel } from "./clipboard-panel";
import { KeyboardBar } from "./keyboard-bar";

const STATE_LABEL: Record<SeatState, string> = {
  AGENT: "Eve has the seat",
  HUMAN: "You have the seat",
  WAITING: "Eve needs you",
};

const STATE_DOT: Record<SeatState, string> = {
  AGENT: "bg-emerald-400",
  HUMAN: "bg-sky-400",
  WAITING: "bg-amber-400",
};

/**
 * The box's screen, and the only way to touch it.
 *
 * The stream itself is view-only, the X server refuses RFB input, so the
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
  const desk = status?.display ?? { height: 800, width: 1280 };
  const elsewhereWaiting = status?.screens.find(
    (candidate) => candidate.state === "WAITING" && candidate.display !== screen?.display,
  );

  const {
    error: inputError,
    cursorRef,
    send,
    handlers,
  } = useSeatInput(seat, display, controllable, desk);
  const screenId = screen ? `${screen.bot_id}:${screen.display}` : "";
  const vncSrc = useStableVncSrc(screen?.vnc_url, screenId);

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
          <div className="w-fit min-w-40">
            <NativeSelect
              aria-label="Screen"
              onChange={(event) => onDisplayChange(Number(event.target.value))}
              size="sm"
              value={display}
            >
              {status.screens.map((candidate) => (
                <NativeSelectOption key={candidate.display} value={candidate.display}>
                  {candidate.bot_id} · screen {candidate.display}
                  {candidate.state === "WAITING" ? " · needs you" : ""}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <span className="text-xs text-mute">{screen?.bot_id ?? "box"}</span>
        )}

        <output className="flex items-center gap-1.5 text-xs text-mute">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          {STATE_LABEL[state]}
        </output>

        <div className="ml-auto flex items-center gap-2">
          {/* Only offered while the seat is yours: the hub refuses typing
              otherwise, so the bar would be a field that eats what you write. */}
          {controllable && (
            <Button
              aria-expanded={showKeyboard}
              onClick={() => setShowKeyboard((open) => !open)}
              size="xs"
              type="button"
              variant="outline"
            >
              Keyboard
            </Button>
          )}
          <Button
            aria-expanded={showClipboard}
            onClick={() => setShowClipboard((open) => !open)}
            size="xs"
            type="button"
            variant="outline"
          >
            Clipboard
          </Button>
          {controllable ? (
            <Button disabled={busy} onClick={() => void presence(false)} size="xs" type="button">
              I&apos;m done
            </Button>
          ) : (
            // Without this the pane is silently dead: you move the mouse over
            // someone else's desktop and nothing happens, with no way to ask
            // for it. Waiting to be offered the seat is not how a person
            // takes over a machine that is going wrong.
            <Button
              disabled={busy}
              onClick={() => void presence(true)}
              size="xs"
              type="button"
              variant="outline"
            >
              Take the seat
            </Button>
          )}
        </div>
      </header>

      {state === "WAITING" && (
        <div
          className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm"
          role="alert"
        >
          <span className="font-medium text-amber-200">Eve needs you: take the seat</span>
          <Button disabled={busy} onClick={() => void presence(true)} size="xs" type="button" variant="warning">
            Take the seat
          </Button>
        </div>
      )}

      {/* A screen you are not looking at can be the one asking for you. */}
      {elsewhereWaiting && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-amber-200">
            {elsewhereWaiting.bot_id} needs you on screen {elsewhereWaiting.display}
          </span>
          <Button onClick={() => onDisplayChange(elsewhereWaiting.display)} size="xs" type="button" variant="outline">
            Switch
          </Button>
        </div>
      )}

      {inputError && (
        <p
          className="border-b border-red-900/60 bg-red-950/40 px-3 py-1.5 text-xs text-red-200"
          role="alert"
        >
          {inputError}
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
              {/* Cross-origin to the hub, with a 15-minute pixel token in the
                  URL. Sandboxed to scripts only: noVNC needs no storage and
                  no same-origin powers, and the frame cannot navigate this
                  window or open popups. No referrer, so the token never
                  leaks to anything the frame might load. */}
              <iframe
                className="absolute inset-0 size-full rounded-lg border border-edge bg-black"
                key={screenId}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts"
                src={vncSrc ?? screen.vnc_url}
                title={`${screen.bot_id} screen`}
              />
              <div
                aria-label="Take over the screen"
                // `touch-pinch-zoom` keeps one finger for the box: no pan, no
                // double-tap zoom, while leaving two fingers to magnify a
                // 1280×800 desk squeezed onto a phone. `select-none` stops the
                // long-press selection callout from eating a held click.
                className={`absolute inset-0 touch-pinch-zoom select-none rounded-lg outline-none ${
                  controllable
                    ? "cursor-none focus-visible:ring-2 focus-visible:ring-ring"
                    : "pointer-events-none"
                }`}
                role="application"
                tabIndex={controllable ? 0 : -1}
                {...handlers}
              />
              {/* The cursor you steer. The box's own cursor is in the video a
                  round trip behind, so this one is drawn here and moved on
                  mousemove; the box follows. */}
              {controllable && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 opacity-0 transition-opacity"
                  ref={cursorRef}
                  style={{ left: 0, top: 0 }}
                >
                  <svg
                    className="-translate-x-px -translate-y-px drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]"
                    fill="none"
                    height="20"
                    viewBox="0 0 12 19"
                    width="13"
                  >
                    <path
                      d="M1 1.5v14l3.2-3.4h5.3L1 1.5z"
                      fill="white"
                      stroke="black"
                      strokeWidth="1.2"
                    />
                  </svg>
                </div>
              )}
            </>
          ) : (
            <p className="absolute inset-0 grid place-items-center text-sm text-mute">
              Connecting…
            </p>
          )}
        </div>
      </div>

      <p className="px-3 pb-2 text-xs text-mute">
        {controllable
          ? "Point where you want the cursor and the box follows. Type here, or open Keyboard on a phone; Backspace and the arrow keys do not go through."
          : "View only while Eve is working. Take the seat to drive it yourself, or wait for it to ask."}
      </p>

      {controllable && showKeyboard && <KeyboardBar onSend={send} />}
      {showClipboard && <ClipboardPanel display={display} seat={seat} />}
    </section>
  );
}

/**
 * Hold the current pixel URL until the grant is close to expiry or the
 * screen identity changes. Rewriting `src` (or keying on `vnc_url`) on
 * every Status poll tears down noVNC.
 *
 * Derived from the previous render with state, not a ref written during
 * render, so the React Compiler can still memoise this component.
 */
function useStableVncSrc(incoming: string | undefined, identity: string): string | undefined {
  const [held, setHeld] = useState<{ identity: string; url: string } | undefined>();
  const stale = held === undefined || held.identity !== identity || !pixelUrlFresh(held.url);
  // Set only when it changes: a URL the browser already judges stale would
  // otherwise be re-set on every render, and React would refuse the loop.
  if (incoming && stale && held?.url !== incoming) {
    setHeld({ identity, url: incoming });
    return incoming;
  }
  return held?.identity === identity ? held.url : undefined;
}
