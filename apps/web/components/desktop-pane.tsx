import {
  ClipboardIcon,
  CrosshairIcon,
  DotGrid1x3HorizontalIcon,
  HelpCircleIcon,
  KeyboardIcon,
  SquareCursorIcon,
  ZoomOutIcon,
} from "blode-icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { captureEvent } from "@/lib/posthog-client";
import { Switch } from "@/components/ui/switch";
import type { BoxStatus, Screen, Seat, SeatState } from "../lib/seat";
import type { DeskMode } from "../lib/use-desk-touch";
import { useDeskView } from "../lib/use-desk-view";
import { useSeatInput } from "../lib/use-seat-input";
import { useVncSrc } from "../lib/use-vnc-src";
import { ClipboardPanel } from "./clipboard-panel";
import { ComputerHelp } from "./computer-help";
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
 *
 * On a phone the pane is the whole page: the controls a thumb needs (type,
 * clipboard, hand it back) sit in a bar at the bottom where a thumb reaches,
 * the gestures are `useDeskTouch`'s, and what they are is written down in
 * `ComputerHelp` rather than left to be discovered on someone's real desktop.
 */
export function DesktopPane({
  display,
  layout = "workspace",
  onDisplayChange,
  onStatus,
  readable,
  seat,
  status,
}: {
  display: number;
  /** Phone: full-bleed screen, a thumb bar, and the touch gestures. */
  layout?: "workspace" | "phone";
  onDisplayChange: (display: number) => void;
  onStatus: (status: BoxStatus) => void;
  /**
   * Whether this seat may read the box clipboard. An invite holds a guest
   * seat, and `ClipboardGet` is not in its method set because reading the box
   * clipboard exfiltrates whatever the last person copied; an owner on the
   * same phone layout may read it.
   */
  readable?: boolean;
  seat: Seat;
  status: BoxStatus | undefined;
}): React.ReactElement {
  const [showClipboard, setShowClipboard] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [mode, setMode] = useState<DeskMode>("direct");
  const [busy, setBusy] = useState(false);

  const screen: Screen | undefined =
    status?.screens.find((candidate) => candidate.display === display) ?? status?.screens[0];
  const state = screen?.state ?? status?.state ?? "AGENT";
  const controllable = state !== "AGENT";
  const desk = status?.display ?? { height: 800, width: 1280 };
  const elsewhereWaiting = status?.screens.find(
    (candidate) => candidate.state === "WAITING" && candidate.display !== screen?.display,
  );

  const view = useDeskView();
  const { containerRef: deskRef, stageRef, zoomed, reset: resetZoom } = view;
  const {
    error: inputError,
    cursorRef,
    recenter,
    send,
    surfaceRef,
    handlers,
  } = useSeatInput(seat, display, controllable, desk, { mode, view });
  const screenId = screen ? `${screen.bot_id}:${screen.display}` : "";
  const vncSrc = useVncSrc(screen?.vnc_url, screenId);

  const presence = async (present: boolean) => {
    setBusy(true);
    try {
      onStatus(await seat.setPresence(present, display));
      // The two ends of a takeover, and the only two events this pane sends:
      // what a person did on the screen is the screen's business.
      captureEvent(present ? "seat_taken" : "seat_returned", {
        layout,
        waiting: state === "WAITING",
      });
    } catch {
      // The next poll re-reads the truth; a failed toggle needs no banner.
    } finally {
      setBusy(false);
    }
  };

  const phone = layout === "phone";
  const canRead = readable ?? !phone;

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overscroll-none">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
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
          <span className="text-muted-foreground text-xs">{screen?.bot_id ?? "box"}</span>
        )}

        <output className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <span className={`size-2 rounded-full ${STATE_DOT[state]}`} />
          {STATE_LABEL[state]}
        </output>

        <div className="ml-auto flex items-center gap-2">
          {phone ? (
            <>
              <Button
                aria-label="Using the computer"
                onClick={() => setShowHelp(true)}
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <HelpCircleIcon />
              </Button>
              <Button
                aria-label="More"
                aria-expanded={showMore}
                onClick={() => setShowMore(true)}
                size="icon-lg"
                type="button"
                variant="ghost"
              >
                <DotGrid1x3HorizontalIcon />
              </Button>
            </>
          ) : (
            <>
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
                <Button
                  disabled={busy}
                  onClick={() => void presence(false)}
                  size="xs"
                  type="button"
                >
                  I’m done
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
            </>
          )}
        </div>
      </header>

      {state === "WAITING" && !phone && (
        <div
          className="flex flex-wrap items-center gap-3 border-amber-500/40 border-b bg-amber-500/15 px-3 py-2 text-sm"
          role="alert"
        >
          <span className="font-medium text-amber-200">Eve needs you: take the seat</span>
          <Button
            disabled={busy}
            onClick={() => void presence(true)}
            size="xs"
            type="button"
            variant="warning"
          >
            Take the seat
          </Button>
        </div>
      )}

      {/* A screen you are not looking at can be the one asking for you. */}
      {elsewhereWaiting && (
        <div className="flex flex-wrap items-center gap-3 border-amber-500/40 border-b bg-amber-500/10 px-3 py-2 text-sm">
          <span className="text-amber-200">
            {elsewhereWaiting.bot_id} needs you on screen {elsewhereWaiting.display}
          </span>
          <Button
            onClick={() => onDisplayChange(elsewhereWaiting.display)}
            size="xs"
            type="button"
            variant="outline"
          >
            Switch
          </Button>
        </div>
      )}

      {inputError && (
        <p
          className="border-red-900/60 border-b bg-red-950/40 px-3 py-1.5 text-red-200 text-xs"
          role="alert"
        >
          {inputError}
        </p>
      )}

      <div
        className={`relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black ${phone ? "p-1" : "p-3"}`}
        ref={deskRef}
      >
        {/* Letterboxed to the box's own aspect so the overlay's CSS pixels map
            cleanly onto its screen. The pinch zoom transforms this element,
            and every coordinate is read back off its rect, so magnifying costs
            the mapping nothing. */}
        <div
          className="relative w-full max-w-full"
          ref={stageRef}
          style={{
            aspectRatio: `${desk.width} / ${desk.height}`,
            maxHeight: "100%",
            transformOrigin: "0 0",
          }}
        >
          {screen ? (
            <>
              {/* Cross-origin to the hub, with a 15-minute pixel token in the
                  URL. No referrer, so the token never leaks to anything the
                  frame might load.

                  `allow-same-origin` is required, not a relaxation: without
                  it the frame gets an opaque origin, and the hub's page loads
                  noVNC with `import("/novnc/core/rfb.js")`, which then counts
                  as a cross-origin module fetch and fails CORS. The result is
                  a black rectangle and no error anywhere on this side. It
                  costs nothing here because the frame is already cross-origin
                  to this app: the origin it gets back is the hub's, never
                  ours, so it still cannot read this document, its storage or
                  its cookies. Everything the sandbox was actually buying is
                  still denied, since neither `allow-popups`,
                  `allow-top-navigation` nor `allow-forms` is listed. */}
              <iframe
                className="absolute inset-0 size-full rounded-lg border border-border bg-black"
                key={screenId}
                referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin"
                src={vncSrc ?? screen.vnc_url}
                title={`${screen.bot_id} screen`}
              />
              <div
                aria-label="Take over the screen"
                // `touch-none` hands every finger to `useDeskTouch`: the
                // browser's own pan, pinch and double-tap zoom would fight the
                // desk's, and on the invite page the viewport has scaling off
                // anyway, so the gestures are the pane's or they are nobody's.
                // `select-none` stops the long-press selection callout from
                // eating a held click.
                className={`absolute inset-0 touch-none select-none rounded-lg outline-none ${
                  controllable
                    ? "cursor-none focus-visible:ring-2 focus-visible:ring-ring"
                    : "pointer-events-none"
                }`}
                ref={surfaceRef}
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
            <p className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
              Connecting…
            </p>
          )}
        </div>
      </div>

      {!phone && (
        <p className="px-3 pb-2 text-muted-foreground text-xs">
          {controllable
            ? "Point where you want the cursor and the box follows. Type here, or open Keyboard on a phone; Backspace and the arrow keys do not go through."
            : "View only while Eve is working. Take the seat to drive it yourself, or wait for it to ask."}
        </p>
      )}

      {controllable && showKeyboard && <KeyboardBar large={phone} onSend={send} />}

      {phone ? (
        <DeskBar
          busy={busy}
          controllable={controllable}
          keyboardOpen={showKeyboard}
          onClipboard={() => setShowClipboard(true)}
          onKeyboard={() => setShowKeyboard((open) => !open)}
          onPresence={(present) => void presence(present)}
          waiting={state === "WAITING"}
        />
      ) : (
        showClipboard && <ClipboardPanel display={display} readable={canRead} seat={seat} />
      )}

      {phone && (
        <Dialog onOpenChange={setShowClipboard} open={showClipboard}>
          <DialogContent className="gap-0 p-0">
            <DialogHeader className="px-5 pt-5 pb-1">
              <DialogTitle>Clipboard</DialogTitle>
            </DialogHeader>
            <ClipboardPanel display={display} readable={canRead} seat={seat} />
          </DialogContent>
        </Dialog>
      )}

      {phone && (
        <Dialog onOpenChange={setShowMore} open={showMore}>
          <DialogContent className="gap-0 p-0">
            <DialogHeader className="px-5 pt-5 pb-1">
              <DialogTitle>Options</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-1 p-3">
              <label
                className="flex items-center gap-3 rounded-xl p-3 text-sm"
                htmlFor="trackpad-mode"
              >
                <SquareCursorIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium">Trackpad mode</span>
                  <span className="block text-muted-foreground text-xs leading-5">
                    Your finger moves the pointer instead of pointing at a place.
                  </span>
                </span>
                <Switch
                  checked={mode === "trackpad"}
                  id="trackpad-mode"
                  onCheckedChange={(checked) => setMode(checked ? "trackpad" : "direct")}
                />
              </label>
              <Button
                className="justify-start"
                disabled={!controllable}
                onClick={() => {
                  recenter();
                  setShowMore(false);
                }}
                size="lg"
                type="button"
                variant="ghost"
              >
                <CrosshairIcon />
                Recenter pointer
              </Button>
              <Button
                className="justify-start"
                disabled={!zoomed}
                onClick={() => {
                  resetZoom();
                  setShowMore(false);
                }}
                size="lg"
                type="button"
                variant="ghost"
              >
                <ZoomOutIcon />
                Reset zoom
              </Button>
              <Button
                className="justify-start"
                onClick={() => {
                  setShowMore(false);
                  setShowHelp(true);
                }}
                size="lg"
                type="button"
                variant="ghost"
              >
                <HelpCircleIcon />
                Using the computer
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      <ComputerHelp onOpenChange={setShowHelp} open={showHelp} readable={canRead} />
    </section>
  );
}

/**
 * The bar a thumb reaches: the clipboard, the seat, and the keyboard.
 *
 * Taking and handing back the seat is the one control that is always here
 * rather than in the header, because it is the only one that changes what the
 * Bot is allowed to do while you hold the phone.
 */
function DeskBar({
  busy,
  controllable,
  keyboardOpen,
  onClipboard,
  onKeyboard,
  onPresence,
  waiting,
}: {
  busy: boolean;
  controllable: boolean;
  keyboardOpen: boolean;
  onClipboard: () => void;
  onKeyboard: () => void;
  onPresence: (present: boolean) => void;
  waiting: boolean;
}): React.ReactElement {
  return (
    <div className="flex shrink-0 items-center gap-2 border-border border-t px-3 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <Button
        aria-label="Clipboard"
        onClick={onClipboard}
        size="icon-lg"
        type="button"
        variant="ghost"
      >
        <ClipboardIcon />
      </Button>
      <div className="flex min-w-0 flex-1 justify-center">
        {controllable ? (
          <Button disabled={busy} onClick={() => onPresence(false)} size="lg" type="button">
            I’m done, continue
          </Button>
        ) : (
          <Button
            disabled={busy}
            onClick={() => onPresence(true)}
            size="lg"
            type="button"
            variant={waiting ? "warning" : "outline"}
          >
            {waiting ? "It needs you: take over" : "Take over"}
          </Button>
        )}
      </div>
      <Button
        aria-expanded={keyboardOpen}
        aria-label="Keyboard"
        disabled={!controllable}
        onClick={onKeyboard}
        size="icon-lg"
        type="button"
        variant="ghost"
      >
        <KeyboardIcon />
      </Button>
    </div>
  );
}
