import { eq } from "drizzle-orm";

import { computerSeat } from "../db/computer-seat";
import { DEFAULT_HUB_URL, trimSlashes } from "./config";
import { db } from "./db";

export interface ComputerSeat {
  hubUrl: string;
  seatToken?: string;
  seatError?: string;
}

function hubUrl(): string {
  return trimSlashes(
    process.env.COMPUTER_HUB_URL ?? process.env.NEXT_PUBLIC_HUB_URL ?? DEFAULT_HUB_URL,
  );
}

async function pairWithHub(hub: string): Promise<{ token: string } | { error: string }> {
  const code = process.env.COMPUTER_SETUP_CODE;
  if (!code) {
    return {
      error: "The web server is missing COMPUTER_SETUP_CODE, so it cannot attach to the computer.",
    };
  }
  try {
    const res = await fetch(`${hub}/computer.v1.Seat/Pair`, {
      body: JSON.stringify({ code }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const envelope = (payload as { error?: { message?: string } } | null)?.error;
      return { error: envelope?.message ?? `Could not pair with the computer (${res.status}).` };
    }
    const token = (payload as { token?: unknown } | null)?.token;
    if (typeof token !== "string" || !token) {
      return { error: "The computer accepted pairing but did not return a seat token." };
    }
    return { token };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reach the computer.";
    return { error: `Could not reach the computer at ${hub}: ${message}` };
  }
}

/** Pair, then remember the token for this user. A failed write still returns the token for this request. */
async function pairAndPersist(userId: string, hub: string): Promise<ComputerSeat> {
  const paired = await pairWithHub(hub);
  if ("error" in paired) {
    return { hubUrl: hub, seatError: paired.error };
  }
  try {
    await db
      .insert(computerSeat)
      .values({ hubUrl: hub, seatToken: paired.token, updatedAt: new Date(), userId })
      .onConflictDoUpdate({
        set: { hubUrl: hub, seatToken: paired.token, updatedAt: new Date() },
        target: computerSeat.userId,
      });
  } catch {
    // The next getSession will Pair again; the token is still good now.
  }
  return { hubUrl: hub, seatToken: paired.token };
}

export async function getOrCreateComputerSeat(userId: string): Promise<ComputerSeat> {
  const hub = hubUrl();
  try {
    const [row] = await db
      .select()
      .from(computerSeat)
      .where(eq(computerSeat.userId, userId))
      .limit(1);
    if (row?.seatToken) {
      return { seatToken: row.seatToken, hubUrl: row.hubUrl || hub };
    }
  } catch {
    // Table may not exist yet on a fresh Turso: Pair still works.
  }
  return pairAndPersist(userId, hub);
}

/** The hub forgot this token (a wiped seats.json): pair again and replace it. */
export function refreshComputerSeat(userId: string): Promise<ComputerSeat> {
  return pairAndPersist(userId, hubUrl());
}
