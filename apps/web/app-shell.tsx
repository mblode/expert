"use client";

import { useEffect, useMemo, useState } from "react";

import { SignInView } from "./components/sign-in-view";
import { createSeat } from "./lib/seat";
import type { BoxStatus } from "./lib/seat";
import { attachSeat, createEmailAuth, defaultHubUrl } from "./lib/auth";
import type { EmailAuth } from "./lib/auth";
import { clearSeat, loadSeat, saveSeat } from "./lib/storage";
import type { StoredSeat } from "./lib/storage";
import { ChatPane } from "./components/chat-pane";
import { DesktopPane } from "./components/desktop-pane";
import { PairView } from "./components/pair-view";

const POLL_MS = 2000;

export function App(): React.ReactElement {
  const auth = useMemo(() => createEmailAuth(), []);
  // `loadSeat` reads localStorage, which does not exist while the page is
  // being prerendered. Reading it in an effect keeps the prerendered markup
  // and the first client render identical — otherwise the export ships the
  // pair screen and a paired browser hydrates into the workspace, which is a
  // mismatch React resolves by throwing the tree away.
  const [stored, setStored] = useState<StoredSeat | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [pairInstead, setPairInstead] = useState(false);

  useEffect(() => {
    let live = true;
    const boot = async () => {
      if (auth) {
        const existing = await auth.currentSession();
        if (existing && live) {
          const hubUrl = loadSeat()?.hubUrl ?? defaultHubUrl();
          try {
            const result = await attachSeat(hubUrl, existing.accessToken);
            if (!live) return;
            const seat: StoredSeat = {
              hubUrl,
              seatToken: result.token,
              email: existing.email,
              source: "otp",
            };
            saveSeat(seat);
            setStored(seat);
            setReady(true);
            return;
          } catch {
            // Expired JWT or a hub that is not wired: fall through to stored
            // pair seat or the sign-in form. Do not wipe a working pair.
          }
        }
      }
      if (!live) return;
      setStored(loadSeat());
      setReady(true);
    };
    void boot();
    return () => {
      live = false;
    };
  }, [auth]);

  if (!ready) return <div className="h-full bg-ink" />;

  if (!stored) {
    if (auth && !pairInstead) {
      return (
        <SignedOut
          auth={auth}
          onPairInstead={() => setPairInstead(true)}
          onSignedIn={(seat) => {
            saveSeat(seat);
            setStored(seat);
          }}
        />
      );
    }
    return (
      <PairView
        onBack={auth ? () => setPairInstead(false) : undefined}
        onPaired={(seat) => {
          saveSeat(seat);
          setStored(seat);
        }}
      />
    );
  }

  return (
    <Workspace
      key={stored.seatToken}
      onSignOut={async () => {
        await auth?.signOut();
        clearSeat();
        setStored(undefined);
        setPairInstead(false);
      }}
      stored={stored}
    />
  );
}

function SignedOut({
  auth,
  onPairInstead,
  onSignedIn,
}: {
  auth: EmailAuth;
  onPairInstead: () => void;
  onSignedIn: (seat: StoredSeat) => void;
}): React.ReactElement {
  const [hubUrl, setHubUrl] = useState(defaultHubUrl);
  const showHub = !process.env.NEXT_PUBLIC_HUB_URL;
  return (
    <SignInView
      auth={auth}
      hubUrl={hubUrl}
      onHubUrl={showHub ? setHubUrl : undefined}
      onPairInstead={onPairInstead}
      onSignedIn={onSignedIn}
    />
  );
}

function Workspace({
  onSignOut,
  stored,
}: {
  onSignOut: () => void;
  stored: StoredSeat;
}): React.ReactElement {
  const seat = useMemo(() => createSeat(stored.hubUrl, stored.seatToken), [stored]);
  const [status, setStatus] = useState<BoxStatus | undefined>(undefined);
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);

  // The seat state is the banner, and it changes without us — Eve asks for the
  // seat on its own schedule — so it is polled rather than derived.
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
        // A seat token only dies one way — the hub restarted and forgot it —
        // and every call will keep failing until we sign in again.
        if (/UNAUTHENTICATED|seat token/i.test(message)) {
          onSignOut();
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
  }, [display, onSignOut, seat]);

  const signedIn = stored.source === "otp" || Boolean(stored.email);
  const leaveLabel = signedIn ? "Sign out" : "Unpair";

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-3 border-b border-edge px-3 py-2">
        <h1 className="text-sm font-semibold">Computer</h1>
        <span className="truncate text-xs text-mute">{stored.email ?? stored.hubUrl}</span>
        {offline && <span className="text-xs text-red-300">{offline}</span>}
        <button
          className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
          onClick={() => void onSignOut()}
          type="button"
        >
          {leaveLabel}
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
        <ChatPane seat={seat} />
      </main>
    </div>
  );
}
