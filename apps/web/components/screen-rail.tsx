"use client";

import { Hand5FingerIcon, ShareScreenIcon } from "blode-icons-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import type { BotProfile, BoxStatus, Screen, Seat, SeatState } from "@/lib/seat";
import { useVncSrc } from "@/lib/use-vnc-src";
import { cn } from "@/lib/utils";
import { DesktopPane } from "./desktop-pane";

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
 * The Agent Computer, as a rail beside the conversation.
 *
 * The chat is the centre of this app and the screen is what the Bot is doing
 * while it talks, so the rail shows pixels and the one control that matters
 * (who holds the seat) and opens the real thing full size. Driving the box is
 * `DesktopPane`'s job and needs the room, so it lives in the dialog: a 320px
 * rail cannot map CSS pixels onto a 1280x800 desk accurately enough to click
 * with, and a control that misses is worse than one that is a click away.
 */
export function ScreenRail({
  display,
  onDisplayChange,
  onStatus,
  profiles,
  seat,
  status,
}: {
  display: number;
  onDisplayChange: (display: number) => void;
  onStatus: (status: BoxStatus) => void;
  /** By Bot id, from the roster: the rail says the Bot's name, not its id. */
  profiles: Record<string, BotProfile>;
  seat: Seat;
  status: BoxStatus | undefined;
}): React.ReactElement {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const screen: Screen | undefined =
    status?.screens.find((candidate) => candidate.display === display) ?? status?.screens[0];
  const state = screen?.state ?? status?.state ?? "AGENT";
  const desk = status?.display ?? { height: 800, width: 1280 };
  const elsewhereWaiting = status?.screens.find(
    (candidate) => candidate.state === "WAITING" && candidate.display !== screen?.display,
  );
  const screenId = screen ? `${screen.bot_id}:${screen.display}` : "";
  const name = screen ? profiles[screen.bot_id]?.name || screen.bot_id : "";
  const vncSrc = useVncSrc(screen?.vnc_url, screenId);

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
    <aside className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <section className="flex flex-col gap-2">
        <h2 className="px-0.5 font-medium text-muted-foreground text-xs">
          {screen ? `${name}’s screen` : "Screen"}
        </h2>

        <Dialog onOpenChange={setOpen} open={open}>
          <DialogTrigger
            render={
              <button
                aria-label={screen ? `Open ${name}’s screen` : "Open the screen"}
                className="group relative block w-full overflow-hidden rounded-xl border border-border bg-black outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ aspectRatio: `${desk.width} / ${desk.height}` }}
                type="button"
              />
            }
          >
            {screen ? (
              <>
                {/* Pixels only. `pointer-events-none` so the frame never eats
                    the click that opens the full pane. On the sandbox, and
                    why `allow-same-origin` is load-bearing rather than a
                    relaxation, see the same iframe in `desktop-pane.tsx`. */}
                <iframe
                  className="pointer-events-none absolute inset-0 size-full"
                  key={screenId}
                  referrerPolicy="no-referrer"
                  sandbox="allow-scripts allow-same-origin"
                  src={vncSrc ?? screen.vnc_url}
                  tabIndex={-1}
                  title={`${name} screen`}
                />
                <span className="absolute inset-0 grid place-items-center bg-black/45 opacity-0 transition-opacity group-hover:opacity-100">
                  <span className="flex items-center gap-1.5 rounded-lg bg-background/90 px-2.5 py-1.5 font-medium text-xs">
                    <ShareScreenIcon className="size-3.5" />
                    Open
                  </span>
                </span>
              </>
            ) : (
              <span className="absolute inset-0 grid place-items-center text-muted-foreground text-sm">
                Connecting…
              </span>
            )}
          </DialogTrigger>

          <DialogContent className="flex h-[92svh] max-w-[calc(100%-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1400px)] [&_header]:pr-12">
            <DialogHeader className="sr-only">
              <DialogTitle>{screen ? `${name} screen` : "Screen"}</DialogTitle>
            </DialogHeader>
            <DesktopPane
              display={display}
              onDisplayChange={onDisplayChange}
              onStatus={onStatus}
              seat={seat}
              status={status}
            />
          </DialogContent>
        </Dialog>

        <p className="flex items-center gap-1.5 px-0.5 text-muted-foreground text-xs">
          <span className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT[state])} />
          {STATE_LABEL[state]}
        </p>
      </section>

      {state === "WAITING" && (
        <div
          className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3"
          role="alert"
        >
          <p className="font-medium text-amber-200 text-sm">
            Eve is stuck and needs the seat back.
          </p>
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => void presence(true)}
            size="sm"
            type="button"
            variant="warning"
          >
            Take the seat
          </Button>
        </div>
      )}

      {elsewhereWaiting && (
        <button
          className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-left text-amber-200 text-xs hover:bg-amber-500/10"
          onClick={() => onDisplayChange(elsewhereWaiting.display)}
          type="button"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-amber-400" />
          <span className="min-w-0 flex-1 truncate">
            {profiles[elsewhereWaiting.bot_id]?.name || elsewhereWaiting.bot_id} needs you on screen{" "}
            {elsewhereWaiting.display}
          </span>
        </button>
      )}

      {state !== "WAITING" && (
        <Button
          className="w-full"
          disabled={busy}
          onClick={() => void presence(state === "AGENT")}
          size="sm"
          type="button"
          variant={state === "AGENT" ? "outline" : "default"}
        >
          <Hand5FingerIcon />
          {state === "AGENT" ? "Take the seat" : "I’m done"}
        </Button>
      )}
    </aside>
  );
}
