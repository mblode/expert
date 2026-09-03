import { eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { invite } from "../db/invite";
import type { EnvMap } from "./computers";
import { db } from "./db";
import {
  grantInviteSeat,
  hashInviteToken,
  inspectInvite,
  isInvitePurpose,
  planInvite,
} from "./invite";
import type { InviteDraft, InvitePurpose, InviteRecord, RedeemFailure, SeatGrant } from "./invite";
import { inviteOrigin, invitePath } from "./invite-origin";
import { issueSeatAsIssuer } from "./issuer";

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
      seat_role TEXT,
      hub_url TEXT
    )
  `);
  // Rows written before scoped seats live in a table without the column, and
  // SQLite has no ADD COLUMN IF NOT EXISTS: a duplicate-column error here is
  // the normal path on every deploy after the first, not a failure.
  await db.run(sql`ALTER TABLE invite ADD COLUMN seat_role TEXT`).catch(() => undefined);
  await db.run(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS invite_token_hash_uidx ON invite (token_hash)`,
  );
}

function asRecord(row: typeof invite.$inferSelect): InviteRecord {
  return {
    computerId: row.computerId,
    expiresAt: row.expiresAt.getTime(),
    purpose: isInvitePurpose(row.purpose) ? row.purpose : "desk",
    ...(row.seatRole ? { seatRole: row.seatRole } : {}),
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

export function mintedInviteFromDraft(
  planned: InviteDraft,
  request: Request | undefined,
  env: EnvMap = process.env,
): MintedInvite {
  return {
    computerId: planned.computerId,
    expiresAt: new Date(planned.expiresAt).toISOString(),
    purpose: planned.purpose,
    url: `${inviteOrigin(request, env)}${invitePath(planned.purpose, planned.token)}`,
  };
}

export async function mintStoredInvite(
  input: {
    computerId?: string;
    kind?: string;
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
  return mintedInviteFromDraft(planned, request, env);
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
  const granted = await grantInviteSeat(
    found as InviteRecord,
    purpose,
    env,
    now,
    issueSeatAsIssuer,
  );
  if ("error" in granted) {
    return granted;
  }
  if (granted.persist) {
    try {
      await db
        .update(invite)
        .set({
          hubUrl: granted.computer.hubUrl,
          seatRole: granted.role,
          seatToken: granted.seatToken,
        })
        .where(eq(invite.tokenHash, (found as InviteRecord).tokenHash));
    } catch {
      // The token is still good for this request; the next redeem issues again.
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
  // Drop the role, not the token: an unset role forces a fresh seat, and the
  // old token still rides along so the hub revokes it as it mints the new one.
  const stale: InviteRecord = { ...(found as InviteRecord), seatRole: undefined };
  const granted = await grantInviteSeat(stale, purpose, env, now, issueSeatAsIssuer);
  if ("error" in granted) {
    return granted;
  }
  try {
    await db
      .update(invite)
      .set({
        hubUrl: granted.computer.hubUrl,
        seatRole: granted.role,
        seatToken: granted.seatToken,
      })
      .where(eq(invite.tokenHash, stale.tokenHash));
  } catch {
    // Same as first redeem: the fresh token is still returned.
  }
  return {
    ...granted,
    computerId: granted.computer.id,
    hubUrl: granted.computer.hubUrl,
  };
}
