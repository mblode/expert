/**
 * Re-pairing from the browser. The web server holds each computer's setup
 * code and the browser never does, so both calls go through this app's own
 * API routes rather than straight to a hub.
 */

import { posthogForwardHeaders } from "./posthog-client";

export interface BoundSeat {
  computerId: string;
  hubUrl: string;
  seatToken: string;
}

function readSeat(body: unknown): BoundSeat | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const { computerId, hubUrl, seatToken } = body as {
    computerId?: string;
    hubUrl?: string;
    seatToken?: string;
  };
  if (!hubUrl || !seatToken) {
    return null;
  }
  return { computerId: computerId ?? "", hubUrl, seatToken };
}

/** Ask the web server to Pair again; it holds the setup code, the browser never does. */
export async function reconnect(): Promise<BoundSeat | null> {
  const res = await fetch("/api/computer/reconnect", {
    headers: posthogForwardHeaders(),
    method: "POST",
  });
  if (!res.ok) {
    return null;
  }
  return readSeat(await res.json().catch(() => null));
}

export async function selectComputer(computerId: string): Promise<BoundSeat | null> {
  const res = await fetch("/api/computer/select", {
    body: JSON.stringify({ computerId }),
    headers: { "content-type": "application/json", ...posthogForwardHeaders() },
    method: "POST",
  });
  if (!res.ok) {
    return null;
  }
  return readSeat(await res.json().catch(() => null));
}
