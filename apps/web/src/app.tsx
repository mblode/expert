import { useEffect, useMemo, useState } from "react";

import { createSeat } from "./lib/seat";
import type { BoxStatus } from "./lib/seat";
import { clearSeat, loadSeat, saveSeat } from "./lib/storage";
import type { StoredSeat } from "./lib/storage";
import { ChatPane } from "./components/chat-pane";
import { DesktopPane } from "./components/desktop-pane";
import { PairView } from "./components/pair-view";

const POLL_MS = 2000;

export function App(): React.ReactElement {
  const [stored, setStored] = useState<StoredSeat | undefined>(loadSeat);

  if (!stored) {
    return (
      <PairView
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
      onUnpair={() => {
        clearSeat();
        setStored(undefined);
      }}
      stored={stored}
    />
  );
}

function Workspace({
  onUnpair,
  stored,
}: {
  onUnpair: () => void;
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
        // and every call will keep failing until we pair again. Sending the
        // user back to pairing is the fix; showing them the envelope is not.
        if (/UNAUTHENTICATED|seat token/i.test(message)) {
          onUnpair();
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
  }, [display, onUnpair, seat]);

  return (
    <div className="grid h-full grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex items-center gap-3 border-b border-edge px-3 py-2">
        <h1 className="text-sm font-semibold">Computer</h1>
        <span className="truncate text-xs text-mute">{stored.hubUrl}</span>
        {offline && <span className="text-xs text-red-300">{offline}</span>}
        <button
          className="ml-auto rounded-md border border-edge px-2.5 py-1 text-xs hover:border-accent"
          onClick={onUnpair}
          type="button"
        >
          Unpair
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
