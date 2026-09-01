"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ConnectError } from "./components/connect-error";
import { ChatPane } from "./components/chat-pane";
import { DesktopPane } from "./components/desktop-pane";
import { LoginForm } from "./components/login-form";
import { authClient } from "./lib/auth-client";
import { createSeat } from "./lib/seat";
import type { BoxStatus } from "./lib/seat";
import { clearSeat } from "./lib/storage";

const POLL_MS = 2000;

export function App({
  appleEnabled = false,
  googleEnabled = false,
}: {
  appleEnabled?: boolean;
  googleEnabled?: boolean;
}): React.ReactElement {
  const { data: session, isPending } = authClient.useSession();

  if (isPending) return <div className="h-full bg-ink" />;

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-sm space-y-5">
          <div>
            <h1 className="text-xl font-semibold">Computer</h1>
            <p className="mt-1 text-sm text-mute">
              Sign in to watch the screen and talk to Eve. The box connects automatically.
            </p>
          </div>
          <LoginForm appleEnabled={appleEnabled} googleEnabled={googleEnabled} />
        </div>
      </div>
    );
  }

  if (session.seatError || !session.seatToken) {
    return (
      <ConnectError
        message={session.seatError ?? "Signed in, but no seat token was issued for the computer."}
        onRetry={() => {
          void fetch("/api/computer/reconnect", { method: "POST" }).then(() => {
            void authClient.getSession();
          });
        }}
        onSignOut={() => {
          void authClient.signOut();
        }}
      />
    );
  }

  return (
    <Workspace
      hubUrl={session.hubUrl}
      key={session.seatToken}
      onSignOut={() => {
        clearSeat();
        void authClient.signOut();
      }}
      seatToken={session.seatToken}
    />
  );
}

function Workspace({
  hubUrl,
  onSignOut,
  seatToken,
}: {
  hubUrl: string;
  onSignOut: () => void;
  seatToken: string;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(hubUrl, seatToken), [hubUrl, seatToken]);
  const [status, setStatus] = useState<BoxStatus | undefined>(undefined);
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);

  const recoverSeat = useCallback(async () => {
    const res = await fetch("/api/computer/reconnect", { method: "POST" });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setOffline(body?.error ?? "The computer rejected the seat token.");
      return false;
    }
    await authClient.getSession();
    return true;
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const next = await seat.status(display);
        if (!live) return;
        setStatus(next);
        setOffline(null);
      } catch (cause) {
        if (!live) return;
        const message = cause instanceof Error ? cause.message : "hub unreachable";
        if (/UNAUTHENTICATED|seat token/i.test(message)) {
          const recovered = await recoverSeat();
          if (!recovered && live) setOffline(message);
          return;
        }
        setOffline(message);
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
        <h1 className="text-sm font-semibold">Expert</h1>
        <span className="truncate text-xs text-mute">{hubUrl}</span>
        {offline && <span className="text-xs text-red-300">{offline}</span>}
        <button
          className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
          onClick={onSignOut}
          type="button"
        >
          Sign out
        </button>
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
