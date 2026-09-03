"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { DesktopPane } from "@/components/desktop-pane";
import { INVITE_HEADER } from "@/lib/invite-access";
import { captureEvent } from "@/lib/posthog-client";
import { createSeat, SeatError } from "@/lib/seat";
import type { BoxStatus } from "@/lib/seat";
import { useLockPageScroll } from "@/lib/use-lock-page-scroll";
import { useVisualViewport } from "@/lib/use-visual-viewport";

const POLL_MS = 2000;

export function InviteDesk({
  computerId,
  hubUrl,
  inviteToken,
  label,
  seatToken,
}: {
  computerId: string;
  hubUrl: string;
  inviteToken: string;
  label: string;
  seatToken: string;
}): React.ReactElement {
  const [token, setToken] = useState(seatToken);
  const seat = useMemo(() => createSeat(hubUrl, token), [hubUrl, token]);
  const [status, setStatus] = useState<BoxStatus | undefined>();
  const [display, setDisplay] = useState(1);
  const [offline, setOffline] = useState<string | null>(null);
  const vv = useVisualViewport();
  useLockPageScroll();

  useEffect(() => {
    captureEvent("desk_opened", { computer_id: computerId, source: "invite" });
  }, [computerId]);

  const recoverSeat = useCallback(async () => {
    const res = await fetch("/api/invite/refresh", {
      headers: { [INVITE_HEADER]: inviteToken },
      method: "POST",
    });
    const body: unknown = await res.json().catch(() => null);
    const next =
      body && typeof body === "object" && "seatToken" in body && typeof body.seatToken === "string"
        ? body.seatToken
        : "";
    if (!res.ok || !next) {
      setOffline("This link could not refresh the seat.");
      return;
    }
    setToken(next);
  }, [inviteToken]);

  useEffect(() => {
    let live = true;
    // Same guard as the workspace: a phone on a slow link, or a Machine still
    // waking, would otherwise stack one Status per tick and let a stale answer
    // land last. See app-shell.tsx.
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
        if (!live) {
          return;
        }
        if (error instanceof SeatError && error.code === "UNAUTHENTICATED") {
          await recoverSeat();
          return;
        }
        setOffline(error instanceof Error ? error.message : "computer unreachable");
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

  return (
    <div
      className="fixed left-0 z-10 flex flex-col overflow-hidden bg-ink overscroll-none"
      style={{
        height: vv.height || "100dvh",
        top: vv.offsetTop,
        width: vv.width || "100%",
      }}
    >
      {offline && (
        <p className="shrink-0 border-b border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-200">
          {offline}
        </p>
      )}
      <p className="sr-only">{label}</p>
      <DesktopPane
        display={display}
        layout="phone"
        onDisplayChange={setDisplay}
        onStatus={setStatus}
        seat={seat}
        status={status}
      />
    </div>
  );
}
