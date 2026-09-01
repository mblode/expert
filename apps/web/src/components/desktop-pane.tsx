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
          <button
            aria-expanded={showClipboard}
            className="rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
            onClick={() => setShowClipboard((open) => !open)}
            type="button"
          >
            Clipboard
          </button>
          {controllable && (
            <button
              className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-ink disabled:opacity-50"
              disabled={busy}
              onClick={() => void presence(false)}
              type="button"
            >
              I&apos;m done
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
                className={`absolute inset-0 rounded-lg outline-none ${
                  controllable ? "cursor-none focus-visible:ring-2 focus-visible:ring-accent" : "pointer-events-none"
                }`}
                role="application"
                tabIndex={controllable ? 0 : -1}
                {...input.handlers}
              />
            </>
          ) : (
            <p className="absolute inset-0 grid place-items-center text-sm text-mute">Connecting…</p>
          )}
        </div>
      </div>

      <p className="px-3 pb-2 text-xs text-mute">
        {controllable
          ? "Click the screen, then move to steer the cursor (relative, like a trackpad). Typing and paste go through; Backspace and the arrow keys do not."
          : "View only while Eve is working. It hands the seat over when it needs you."}
      </p>

      {showClipboard && <ClipboardPanel display={display} seat={seat} />}
    </section>
  );
}
