"use client";

import { ComputerUseIcon } from "blode-icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BotSidebar } from "./components/bot-sidebar";
import { ChatPane } from "./components/chat-pane";
import { ConnectError } from "./components/connect-error";
import { ScreenRail } from "./components/screen-rail";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./components/ui/dialog";
import { authClient } from "./lib/auth-client";
import { captureEvent, identifyUser, resetPostHog } from "./lib/posthog-client";
import { reconnect, selectComputer } from "./lib/reconnect";
import type { BoundSeat } from "./lib/reconnect";
import { createSeat, SeatError } from "./lib/seat";
import type { BoxStatus } from "./lib/seat";
import { clearSessions } from "./lib/storage";

const POLL_MS = 2000;

/**
 * Sign-out ends the seat on the hub too. Before scopes a seat token lived
 * forever in `seats.json`; now the browser's token goes with the session.
 * Best effort: a hub that is asleep or unreachable must not block signing out.
 */
function signOut(seat?: { hubUrl: string; seatToken: string }): void {
  clearSessions();
  resetPostHog();
  const revoke = seat
    ? createSeat(seat.hubUrl, seat.seatToken)
        .revoke()
        .catch(() => undefined)
    : Promise.resolve();
  void revoke.finally(() =>
    authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign("/") } }),
  );
}

/** The server page already required a session; this only reads the seat off it. */
export function App(): React.ReactElement {
  const { data: session, isPending } = authClient.useSession();
  const [recovered, setRecovered] = useState<BoundSeat | null>(null);

  useEffect(() => {
    if (!session?.user?.id) {
      return;
    }
    identifyUser(session.user.id, session.user.email);
  }, [session?.user?.id, session?.user?.email]);

  const seat =
    recovered ??
    (session?.seatToken
      ? {
          computerId: session.computerId,
          hubUrl: session.hubUrl,
          seatToken: session.seatToken,
        }
      : null);

  if (isPending && !seat) {
    return <div className="h-full bg-background" />;
  }

  if (!seat) {
    return (
      <ConnectError
        message={session?.seatError ?? "Signed in, but no seat token was issued for the computer."}
        onRetry={async () => {
          const next = await reconnect();
          if (next) {
            setRecovered(next);
          }
        }}
        onSignOut={() => signOut()}
      />
    );
  }

  return (
    <Workspace
      computerId={seat.computerId}
      computers={session?.computers ?? []}
      connectEvent={recovered ? "computer_reconnected" : "computer_connected"}
      hubUrl={seat.hubUrl}
      key={seat.seatToken}
      onRecovered={setRecovered}
      onSignOut={() => signOut({ hubUrl: seat.hubUrl, seatToken: seat.seatToken })}
      seatToken={seat.seatToken}
      userEmail={session?.user?.email}
    />
  );
}

/**
 * Three panes: the Bots you can talk to, the conversation, and what the Bot is
 * looking at.
 *
 * The conversation is the centre because that is where the work is asked for
 * and reported; the screen is evidence beside it rather than the page itself,
 * which is the one structural thing that separates a computer you delegate to
 * from a remote desktop with a chat box bolted on.
 *
 * Below `lg` the rails are drawers: a phone gets the conversation full width
 * and reaches the roster and the screen from the header.
 */
function Workspace({
  computerId,
  computers,
  connectEvent,
  hubUrl,
  onRecovered,
  onSignOut,
  seatToken,
  userEmail,
}: {
  computerId: string;
  computers: { id: string; label: string }[];
  connectEvent: "computer_connected" | "computer_reconnected";
  hubUrl: string;
  onRecovered: (seat: BoundSeat) => void;
  onSignOut: () => void;
  seatToken: string;
  userEmail?: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [status, setStatus] = useState<BoxStatus | undefined>();
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);
  const [botsOpen, setBotsOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);

  useEffect(() => {
    captureEvent(connectEvent, { computer_id: computerId });
  }, [computerId, connectEvent]);

  const recoverSeat = useCallback(async () => {
    const next = await reconnect();
    if (!next) {
      setOffline("The computer rejected the seat token and could not issue a new one.");
      return;
    }
    onRecovered(next);
  }, [onRecovered]);

  const switchComputer = useCallback(
    async (nextId: string) => {
      if (nextId === computerId) {
        return;
      }
      const next = await selectComputer(nextId);
      if (next) {
        onRecovered(next);
      }
    },
    [computerId, onRecovered],
  );

  useEffect(() => {
    let live = true;
    // A suspended Machine takes seconds to wake and Status has no client-side
    // timeout, so without this the wake queues a poll every two seconds and
    // whichever answers last repaints the seat, which can be the oldest.
    let inFlight = false;
    const tick = async () => {
      if (inFlight) {
        return;
      }
      inFlight = true;
      try {
        const next = await seat.status(display);
        if (!live) {
          return;
        }
        setStatus(next);
        setOffline(null);
      } catch (error) {
        if (!live) return;
        if (error instanceof SeatError && error.code === "UNAUTHENTICATED") {
          await recoverSeat();
          return;
        }
        setOffline(error instanceof Error ? error.message : "hub unreachable");
      } finally {
        inFlight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [display, recoverSeat, seat]);

  const screens = status?.screens ?? [];
  const botId = screens.find((s) => s.display === display)?.bot_id ?? "main";
  const waitingElsewhere = screens.some((s) => s.state === "WAITING" && s.display !== display);

  const pickDisplay = useCallback((next: number) => {
    setDisplay(next);
    setBotsOpen(false);
  }, []);

  const sidebar = (
    <BotSidebar
      computerId={computerId}
      computers={computers}
      display={display}
      onDisplayChange={pickDisplay}
      onSignOut={onSignOut}
      onSwitchComputer={switchComputer}
      screens={screens}
      userEmail={userEmail}
    />
  );

  const rail = (
    <ScreenRail
      display={display}
      onDisplayChange={setDisplay}
      onStatus={setStatus}
      seat={seat}
      status={status}
    />
  );

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[17rem_minmax(0,1fr)_20rem] xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
      <div className="hidden min-h-0 border-border border-r lg:block">{sidebar}</div>

      {/* The conversation owns the only header on a phone too: the drawers open
          from its own bar rather than a second one that repeats the Bot's name. */}
      <ChatPane
        botId={botId}
        key={botId}
        onOpenBots={() => setBotsOpen(true)}
        onOpenScreen={() => setScreenOpen(true)}
        screenNeedsYou={waitingElsewhere}
        seat={seat}
      />

      <div className="hidden min-h-0 border-border border-l lg:block">{rail}</div>

      {offline && (
        <output className="fixed inset-x-0 bottom-0 z-50 block bg-destructive/90 px-4 py-1.5 text-center text-destructive-foreground text-xs">
          {offline}
        </output>
      )}

      <Dialog onOpenChange={setBotsOpen} open={botsOpen}>
        <DialogContent className="h-[85svh] max-w-sm gap-0 overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Bots</DialogTitle>
          </DialogHeader>
          {sidebar}
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setScreenOpen} open={screenOpen}>
        <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>
              <ComputerUseIcon className="sr-only" />
              Screen
            </DialogTitle>
          </DialogHeader>
          {rail}
        </DialogContent>
      </Dialog>
    </div>
  );
}
