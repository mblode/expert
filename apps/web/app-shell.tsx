"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Button } from "./components/ui/button";
import { ConnectError } from "./components/connect-error";
import { ChatPane } from "./components/chat-pane";
import { DesktopPane } from "./components/desktop-pane";
import { authClient } from "./lib/auth-client";
import { siteConfig } from "./lib/config";
import { createSeat, SeatError } from "./lib/seat";
import type { BoxStatus } from "./lib/seat";
import { clearSessions } from "./lib/storage";

const POLL_MS = 2000;

function signOut(): void {
  clearSessions();
  void authClient.signOut({ fetchOptions: { onSuccess: () => window.location.assign("/") } });
}

/** The server page already required a session; this only reads the seat off it. */
export function App(): React.ReactElement {
  const { data: session, isPending } = authClient.useSession();
  const [recovered, setRecovered] = useState<{ hubUrl: string; seatToken: string } | null>(null);

  const seat =
    recovered ??
    (session?.seatToken ? { hubUrl: session.hubUrl, seatToken: session.seatToken } : null);

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
        onSignOut={signOut}
      />
    );
  }

  return (
    <Workspace
      hubUrl={seat.hubUrl}
      key={seat.seatToken}
      onRecovered={setRecovered}
      onSignOut={signOut}
      seatToken={seat.seatToken}
    />
  );
}

/** Ask the web server to Pair again; it holds the setup code, the browser never does. */
async function reconnect(): Promise<{ hubUrl: string; seatToken: string } | null> {
  const res = await fetch("/api/computer/reconnect", { method: "POST" });
  if (!res.ok) {
    return null;
  }
  const body = (await res.json().catch(() => null)) as {
    hubUrl?: string;
    seatToken?: string;
  } | null;
  return body?.hubUrl && body.seatToken ? { hubUrl: body.hubUrl, seatToken: body.seatToken } : null;
}

function Workspace({
  hubUrl,
  onRecovered,
  onSignOut,
  seatToken,
}: {
  hubUrl: string;
  onRecovered: (seat: { hubUrl: string; seatToken: string }) => void;
  onSignOut: () => void;
  seatToken: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [status, setStatus] = useState<BoxStatus | undefined>();
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);

  const recoverSeat = useCallback(async () => {
    const next = await reconnect();
    if (!next) {
      setOffline("The computer rejected the seat token and could not issue a new one.");
      return;
    }
    onRecovered(next);
  }, [onRecovered]);

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
        {offline && <output className="truncate text-xs text-red-300">{offline}</output>}
        <Button className="ml-auto" onClick={onSignOut} size="xs" type="button" variant="outline">
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
