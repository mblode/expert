import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { invite } from "../db/invite";
import { ensureComputerCatalog } from "./computer-seat";
import type { EnvMap } from "./computers";
import { db } from "./db";
import {
  grantInviteSeat,
  hashInviteToken,
  inspectInvite,
  isInvitePurpose,
  planInvite,
} from "./invite";
import type { InvitePurpose, InviteRecord, RedeemFailure, SeatGrant } from "./invite";
import { inviteOrigin, invitePath } from "./invite-origin";

export interface MintedInvite {
  computerId: string;
  expiresAt: string;
  purpose: InvitePurpose;
  url: string;
}

async function ensureInviteTable(): Promise<void> {
  await db.run(sql`
    CREATE TABLE IF NOT EXISTS invite (
      id TEXT PRIMARY KEY NOT NULL,
      token_hash TEXT NOT NULL,
      computer_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      sender_hash TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      seat_token TEXT,
      hub_url TEXT
    )
  `);
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS invite_token_hash_uidx ON invite (token_hash)`,
  );
}

function asRecord(row: typeof invite.$inferSelect): InviteRecord {
  return {
    computerId: row.computerId,
    expiresAt: row.expiresAt.getTime(),
    purpose: isInvitePurpose(row.purpose) ? row.purpose : "desk",
    ...(row.seatToken ? { seatToken: row.seatToken } : {}),
    ...(row.senderHash ? { senderHash: row.senderHash } : {}),
    tokenHash: row.tokenHash,
  };
}

async function byTokenHash(tokenHash: string): Promise<InviteRecord | undefined> {
  try {
    await ensureInviteTable();
    const [row] = await db.select().from(invite).where(eq(invite.tokenHash, tokenHash)).limit(1);
    return row ? asRecord(row) : undefined;
  } catch {
    return undefined;
  }
}

export async function mintStoredInvite(
  input: {
    computerId?: string;
    purpose?: string;
    sender?: string;
    ttlMinutes?: number;
  },
  request: Request | undefined,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<MintedInvite | RedeemFailure> {
  const planned = planInvite(input, env, now);
  if ("error" in planned) {
    return planned;
  }
  try {
    await ensureInviteTable();
    await ensureComputerCatalog();
    await db.insert(invite).values({
      computerId: planned.computerId,
      createdAt: new Date(now),
      expiresAt: new Date(planned.expiresAt),
      id: randomUUID(),
      purpose: planned.purpose,
      senderHash: planned.senderHash,
      tokenHash: planned.tokenHash,
    });
  } catch {
    return { error: "Could not save the invite.", status: 502 };
  }
  return {
    computerId: planned.computerId,
    expiresAt: new Date(planned.expiresAt).toISOString(),
    purpose: planned.purpose,
    url: `${inviteOrigin(request)}${invitePath(planned.purpose, planned.token)}`,
  };
}

/** Validate the link and name the computer. Does not Pair: plugins are files. */
export async function loadStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<{ computerId: string; hubUrl: string; label: string } | RedeemFailure> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { error: "This link is not valid.", status: 404 };
  }
  const found = await byTokenHash(hashInviteToken(trimmed));
  const inspected = inspectInvite(found, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  return {
    computerId: inspected.computer.id,
    hubUrl: inspected.computer.hubUrl,
    label: inspected.computer.label,
  };
}

export async function redeemStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<(SeatGrant & { computerId: string; hubUrl: string }) | RedeemFailure> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { error: "This link is not valid.", status: 404 };
  }
  const found = await byTokenHash(hashInviteToken(trimmed));
  const inspected = inspectInvite(found, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  const granted = await grantInviteSeat(found as InviteRecord, purpose, env, now);
  if ("error" in granted) {
    return granted;
  }
  if (granted.persist) {
    try {
      await db
        .update(invite)
        .set({ hubUrl: granted.computer.hubUrl, seatToken: granted.seatToken })
        .where(eq(invite.tokenHash, (found as InviteRecord).tokenHash));
    } catch {
      // The token is still good for this request; the next redeem pairs again.
    }
  }
  return {
    ...granted,
    computerId: granted.computer.id,
    hubUrl: granted.computer.hubUrl,
  };
}

export async function refreshStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<(SeatGrant & { computerId: string; hubUrl: string }) | RedeemFailure> {
  const found = await byTokenHash(hashInviteToken(token.trim()));
  const inspected = inspectInvite(found, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  const withoutSeat: InviteRecord = { ...(found as InviteRecord), seatToken: undefined };
  const granted = await grantInviteSeat(withoutSeat, purpose, env, now);
  if ("error" in granted) {
    return granted;
  }
  try {
    await db
      .update(invite)
      .set({ hubUrl: granted.computer.hubUrl, seatToken: granted.seatToken })
      .where(eq(invite.tokenHash, withoutSeat.tokenHash));
  } catch {
    // Same as first redeem: the fresh token is still returned.
  }
  return {
    ...granted,
    computerId: granted.computer.id,
    hubUrl: granted.computer.hubUrl,
  };
}
