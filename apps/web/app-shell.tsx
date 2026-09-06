"use client";

import { ComputerUseIcon } from "blode-icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { BotSettings } from "./components/bot-settings";
import { BotSidebar } from "./components/bot-sidebar";
import { NewBot } from "./components/new-bot";
import { ShareTemplate } from "./components/share-template";
import { ChatPane } from "./components/chat-pane";
import { ConnectError } from "./components/connect-error";
import { DesktopPane } from "./components/desktop-pane";
import { ScreenRail } from "./components/screen-rail";
import { CodingWork } from "./components/coding-work";
import { InvitePlugins } from "./components/invite-plugins";
import type { WorkTarget } from "./lib/work-target";
import { workTargetMatches } from "./lib/work-target";
import Link from "next/link";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { authClient } from "./lib/auth-client";
import { captureEvent, identifyUser, resetPostHog } from "./lib/posthog-client";
import { reconnect, selectComputer } from "./lib/reconnect";
import type { BoundSeat } from "./lib/reconnect";
import { createSeat, SeatError } from "./lib/seat";
import type { BotProfile, BoxStatus } from "./lib/seat";
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

const NO_TOOLS: string[] = [];

/** The server page already required a session; this only reads the seat off it. */
export function App({
  initialTarget,
  tools = NO_TOOLS,
}: { initialTarget?: WorkTarget; tools?: string[] } = {}): React.ReactElement {
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
      initialTarget={initialTarget}
      computerId={seat.computerId}
      computers={session?.computers ?? []}
      connectEvent={recovered ? "computer_reconnected" : "computer_connected"}
      hubUrl={seat.hubUrl}
      key={seat.seatToken}
      onRecovered={setRecovered}
      onSignOut={() => signOut({ hubUrl: seat.hubUrl, seatToken: seat.seatToken })}
      seatToken={seat.seatToken}
      tools={tools}
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
  initialTarget,
  computerId,
  computers,
  connectEvent,
  hubUrl,
  onRecovered,
  onSignOut,
  seatToken,
  tools,
  userEmail,
}: {
  initialTarget?: WorkTarget;
  computerId: string;
  computers: { id: string; label: string }[];
  connectEvent: "computer_connected" | "computer_reconnected";
  hubUrl: string;
  onRecovered: (seat: BoundSeat) => void;
  onSignOut: () => void;
  seatToken: string;
  /** What this account said it lives in, at the first run. Empty is normal. */
  tools: string[];
  userEmail?: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [status, setStatus] = useState<BoxStatus | undefined>();
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);
  const [botsOpen, setBotsOpen] = useState(false);
  const [screenOpen, setScreenOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profiles, setProfiles] = useState<Record<string, BotProfile>>({});
  const [newBotOpen, setNewBotOpen] = useState(false);
  const [targetReady, setTargetReady] = useState(!initialTarget);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

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

  /**
   * Who the Bots are, beside what their screens are doing.
   *
   * A separate read from `Status` on purpose: a profile is a file on the box,
   * so the roster costs a read per Bot and the two-second poll is for seat
   * state alone. Read once per seat; a save puts what the hub stored straight
   * into this map, so there is nothing to re-read after one.
   */
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const { bots } = await seat.roster();
        if (live) {
          if (initialTarget) {
            const selected = bots.find((row) => row.id === initialTarget.bot);
            if (!workTargetMatches(initialTarget, hubUrl) || !selected)
              setTargetError("This work is not available on the selected computer.");
            else {
              setDisplay(selected.display);
              setTargetReady(true);
            }
          }
          // `bot.profile` is absent on a hub older than `Seat.SetBotProfile`.
          // Keeping only the entries that arrived is what makes the settings
          // gate below honest: a hub that cannot answer the read cannot serve
          // the write either.
          setProfiles(
            Object.fromEntries(
              bots.filter((bot) => bot.profile).map((bot) => [bot.id, bot.profile]),
            ),
          );
        }
      } catch {
        if (live && initialTarget)
          setTargetError("Could not open this work. Return to your workspace and reconnect.");
        // A mark falls back to the id's own colour and every name to its id,
        // so a roster that will not answer costs polish, not the workspace.
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [seat, initialTarget, hubUrl]);

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
      // Undefined until the first poll answers. An empty roster and a roster
      // that has not arrived yet are different sentences in the sidebar, and
      // on a suspended Machine the wake is seconds long, so the wrong one is
      // what an operator sees on most cold loads.
      loading={status === undefined}
      onDisplayChange={pickDisplay}
      // Same gate as the settings sheet: a hub that cannot serve the roster
      // read cannot serve the write either, so the button is not offered.
      // `profiles` and not `status`: the roster is owner-only, so its rows are
      // what prove this seat may also write. `status` would offer the button
      // to a seat whose `CreateBot` comes back UNAUTHENTICATED.
      onNewBot={Object.keys(profiles).length > 0 ? () => setNewBotOpen(true) : undefined}
      onSignOut={onSignOut}
      onSwitchComputer={switchComputer}
      profiles={profiles}
      screens={screens}
      userEmail={userEmail}
    />
  );

  const rail = (
    <ScreenRail
      display={display}
      onDisplayChange={setDisplay}
      onStatus={setStatus}
      profiles={profiles}
      seat={seat}
      status={status}
    />
  );

  if (initialTarget) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <nav className="flex shrink-0 items-center justify-between gap-3 border-border border-b px-4 py-3 text-sm">
          <Link href="/">Open workspace</Link>
          <span className="text-muted-foreground">Close this page to return to WhatsApp</span>
        </nav>
        {targetError ? (
          <p className="p-5" role="alert">
            {targetError}
          </p>
        ) : targetReady ? (
          initialTarget.view === "computer" ? (
            <DesktopPane
              display={display}
              layout="phone"
              onDisplayChange={setDisplay}
              onStatus={setStatus}
              readable
              seat={seat}
              status={status}
            />
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {initialTarget.view === "code" ? (
                <CodingWork
                  seat={seat}
                  display={display}
                  sourceConversation={initialTarget.conversation}
                />
              ) : (
                <InvitePlugins computerId={computerId} label={computerId} bot={initialTarget.bot} />
              )}
            </div>
          )
        ) : (
          <p className="p-5">Opening your work…</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid h-full min-h-0 lg:grid-cols-[17rem_minmax(0,1fr)_20rem] xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
      <div className="hidden min-h-0 border-border border-r lg:block">{sidebar}</div>

      {/* The conversation owns the only header on a phone too: the drawers open
          from its own bar rather than a second one that repeats the Bot's name. */}
      <ChatPane
        botId={botId}
        display={display}
        key={botId}
        offline={offline}
        onOpenBots={() => setBotsOpen(true)}
        onOpenScreen={() => setScreenOpen(true)}
        // Only when this hub actually serves profiles. hello.expert is
        // deployed ahead of the Machines it talks to, so a browser on the new
        // web app routinely meets an older hub; offering a settings gear there
        // would open a form whose Save is a 404. No gear is the honest answer,
        // and the workspace is unchanged otherwise.
        onOpenSettings={profiles[botId] ? () => setSettingsOpen(true) : undefined}
        onRetry={() => void recoverSeat()}
        profile={profiles[botId]}
        screenNeedsYou={waitingElsewhere}
        seat={seat}
        seatState={screens.find((s) => s.display === display)?.state}
        tools={tools}
      />

      <div className="hidden min-h-0 border-border border-l lg:block">{rail}</div>

      <Dialog onOpenChange={setBotsOpen} open={botsOpen}>
        <DialogContent className="h-[85svh] max-w-sm gap-0 overflow-hidden p-0">
          <DialogHeader className="sr-only">
            <DialogTitle>Bots</DialogTitle>
          </DialogHeader>
          {sidebar}
        </DialogContent>
      </Dialog>

      {/* Making a Bot is the one thing here that adds to the computer rather
          than driving it, so it says what it costs: a screen, and a mind that
          starts out generic and is shaped by what you tell it. */}
      <Dialog onOpenChange={setNewBotOpen} open={newBotOpen}>
        <DialogContent className="max-h-[90svh] max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle>New Bot</DialogTitle>
            <DialogDescription>
              It gets its own screen on {computerId} and its own thread. Tell it what it is for and
              it starts as that.
            </DialogDescription>
          </DialogHeader>
          <NewBot
            existingIds={screens.map((s) => s.bot_id)}
            onCreated={({ display: made, id, profile }) => {
              setProfiles((prev) => ({ ...prev, [id]: profile }));
              setNewBotOpen(false);
              pickDisplay(made);
            }}
            seat={seat}
          />
        </DialogContent>
      </Dialog>

      <Dialog onOpenChange={setSettingsOpen} open={settingsOpen}>
        <DialogContent className="max-h-[90svh] max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle>{profiles[botId]?.name ?? botId}</DialogTitle>
            <DialogDescription>
              Who this Bot is on {computerId}. It reads this as its own instructions.
            </DialogDescription>
          </DialogHeader>
          <BotSettings
            botId={botId}
            key={botId}
            onSaved={(profile) => setProfiles((prev) => ({ ...prev, [botId]: profile }))}
            onShare={() => {
              setSettingsOpen(false);
              setShareOpen(true);
            }}
            profile={profiles[botId]}
            seat={seat}
          />
        </DialogContent>
      </Dialog>

      {/* Its own sheet rather than a panel inside the settings one: what is
          being decided here is what leaves this computer, and that deserves
          the whole surface and its own way out. */}
      <Dialog onOpenChange={setShareOpen} open={shareOpen}>
        <DialogContent className="max-h-[90svh] max-w-md gap-0 overflow-hidden p-0">
          <DialogHeader className="px-5 pt-5 pb-4">
            <DialogTitle>Share as Template</DialogTitle>
            <DialogDescription>
              A copy of this Bot’s setup, behind a link. Bots made from it run on the computer of
              whoever adds them.
            </DialogDescription>
          </DialogHeader>
          <ShareTemplate
            botId={botId}
            botName={profiles[botId]?.name ?? botId}
            computerId={computerId}
            key={botId}
            seat={seat}
          />
        </DialogContent>
      </Dialog>

      {/* On a phone the screen is the whole page while you are on it, not a
          card of it: the rail's job is to sit beside a conversation, and there
          is no beside. This is the same pane the invite link opens, with the
          owner's clipboard because an owner seat may read it. */}
      <Dialog onOpenChange={setScreenOpen} open={screenOpen}>
        <DialogContent className="h-dvh max-h-none w-screen max-w-none gap-0 overflow-hidden rounded-none border-0 p-0 sm:max-w-none [&_header]:pr-12">
          <DialogHeader className="sr-only">
            <DialogTitle>
              <ComputerUseIcon className="sr-only" />
              Screen
            </DialogTitle>
          </DialogHeader>
          <DesktopPane
            display={display}
            layout="phone"
            onDisplayChange={setDisplay}
            onStatus={setStatus}
            readable
            seat={seat}
            status={status}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
