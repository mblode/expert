"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "./components/ui/button";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { ConnectError } from "./components/connect-error";
import { ChatPane } from "./components/chat-pane";
import { DesktopPane } from "./components/desktop-pane";
import { authClient } from "./lib/auth-client";
import { siteConfig } from "./lib/config";
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
    return <div className="h-full bg-ink" />;
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
    />
  );
}

function Workspace({
  computerId,
  computers,
  connectEvent,
  hubUrl,
  onRecovered,
  onSignOut,
  seatToken,
}: {
  computerId: string;
  computers: { id: string; label: string }[];
  connectEvent: "computer_connected" | "computer_reconnected";
  hubUrl: string;
  onRecovered: (seat: BoundSeat) => void;
  onSignOut: () => void;
  seatToken: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [status, setStatus] = useState<BoxStatus | undefined>();
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);

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
    const tick = async () => {
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
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [display, recoverSeat, seat]);

  const botId = status?.screens.find((s) => s.display === display)?.bot_id ?? "main";

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-3 border-b border-edge px-3 py-2">
        <h1 className="text-sm font-semibold">{siteConfig.name}</h1>
        {computers.length > 1 && (
          <div className="w-36">
            <NativeSelect
              aria-label="Computer"
              onChange={(event) => {
                void switchComputer(event.target.value);
              }}
              size="sm"
              value={computerId}
            >
              {computers.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </div>
        )}
        {offline && <output className="truncate text-xs text-red-300">{offline}</output>}
        {/* Channels is the first owner page beside the desk; WhatsApp is the only channel so far, so the link goes straight to it. */}
        <Button
          className="ml-auto"
          render={<Link href="/channels/whatsapp" />}
          size="xs"
          variant="outline"
        >
          Channels
        </Button>
        <Button onClick={onSignOut} size="xs" type="button" variant="outline">
          Sign out
        </Button>
      </header>

      <main className="grid min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,20rem)] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1">
        <DesktopPane
          display={display}
          onDisplayChange={setDisplay}
          onStatus={setStatus}
          seat={seat}
          status={status}
        />
        <ChatPane botId={botId} key={botId} seat={seat} />
      </main>
    </div>
  );
}
