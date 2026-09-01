import { eq } from "drizzle-orm";

import { computerSeat } from "../db/computer-seat";
import { db } from "./db";

const DEFAULT_HUB = "https://mblode-computer.fly.dev";

export type ComputerSeat = {
  hubUrl: string;
  seatToken?: string;
  seatError?: string;
};

export function hubUrl(): string {
  return (process.env.COMPUTER_HUB_URL ?? process.env.NEXT_PUBLIC_HUB_URL ?? DEFAULT_HUB).replace(
    /\/+$/u,
    "",
  );
}

async function pairWithHub(hub: string): Promise<{ token: string } | { error: string }> {
  const code = process.env.COMPUTER_SETUP_CODE;
  if (!code) {
    return { error: "The web server is missing COMPUTER_SETUP_CODE, so it cannot attach to the computer." };
  }
  try {
    const res = await fetch(`${hub}/computer.v1.Seat/Pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
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
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "Could not reach the computer.";
    return { error: `Could not reach the computer at ${hub}: ${message}` };
  }
}

async function persistSeat(userId: string, token: string, hub: string): Promise<void> {
  await db
    .insert(computerSeat)
    .values({ userId, seatToken: token, hubUrl: hub, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: computerSeat.userId,
      set: { seatToken: token, hubUrl: hub, updatedAt: new Date() },
    });
}

export async function getOrCreateComputerSeat(userId: string): Promise<ComputerSeat> {
  const hub = hubUrl();
  try {
    const existing = await db.select().from(computerSeat).where(eq(computerSeat.userId, userId)).limit(1);
    const row = existing[0];
    if (row?.seatToken) {
      return { seatToken: row.seatToken, hubUrl: row.hubUrl || hub };
    }
  } catch {
    // Table may not exist yet on a fresh Turso — Pair still works; persist may fail below.
  }

  const paired = await pairWithHub(hub);
  if ("error" in paired) {
    return { hubUrl: hub, seatError: paired.error };
  }
  try {
    await persistSeat(userId, paired.token, hub);
  } catch {
    // Session still carries the token this request; the next getSession will Pair again.
  }
  return { seatToken: paired.token, hubUrl: hub };
}

export async function refreshComputerSeat(userId: string): Promise<ComputerSeat> {
  const hub = hubUrl();
  const paired = await pairWithHub(hub);
  if ("error" in paired) {
    return { hubUrl: hub, seatError: paired.error };
  }
  try {
    await persistSeat(userId, paired.token, hub);
  } catch {
    // Same as getOrCreate: the token is still returned on this request.
  }
  return { seatToken: paired.token, hubUrl: hub };
}
