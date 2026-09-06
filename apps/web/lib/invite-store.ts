import { and, count, eq, gte, sql } from "drizzle-orm";
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

/**
 * Once per warm instance, not once per lookup.
 *
 * All three statements are idempotent and the ALTER always throws, so running
 * them in front of every invite read bought nothing and cost three round trips
 * to Turso before the row was even selected. The first caller's promise is the
 * answer for every later one. A failure is not cached: the promise is dropped
 * so the next call retries rather than inheriting it forever.
 */
let inviteTableReady: Promise<void> | undefined;

function ensureInviteTable(): Promise<void> {
  inviteTableReady ??= createInviteTable().catch((error: unknown) => {
    inviteTableReady = undefined;
    throw error;
  });
  return inviteTableReady;
}

async function createInviteTable(): Promise<void> {
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

/**
 * How many links may be handed out in ten minutes when the caller is a Bot
 * rather than an operator: one bound per sender, one for the computer they
 * share.
 *
 * Anyone who can @mention the Bot can ask it for the desk, which is the
 * product (`docs/WHATSAPP-PARITY.md` decision 5), and each link redeems to a
 * seat on a screen that other people are also on. A cap is what stops one
 * member, or one model in a loop, turning that into an unbounded supply of
 * them. Three is more than one conversation needs; forty is a busy group and
 * still far fewer than a loop produces. An operator is an account with its own
 * computer and is not counted.
 */
const MINT_WINDOW_MS = 10 * 60_000;
const MINT_WINDOW_MAX = 40;
const SENDER_WINDOW_MAX = 3;

/**
 * Links minted inside the window, for one computer or for one sender on it.
 * Fails open: the row store is the same one the insert below needs, so a
 * database that cannot answer this is about to refuse the mint anyway, and
 * guessing "over the limit" from an error would turn a blip into a refusal a
 * member cannot understand.
 */
async function mintsInWindow(
  computerId: string,
  since: number,
  senderHash?: string,
): Promise<number> {
  try {
    await ensureInviteTable();
    const [row] = await db
      .select({ minted: count() })
      .from(invite)
      .where(
        and(
          eq(invite.computerId, computerId),
          gte(invite.createdAt, new Date(since)),
          ...(senderHash ? [eq(invite.senderHash, senderHash)] : []),
        ),
      );
    return row?.minted ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Whether this mint is over a cap, and which one.
 *
 * The per-computer cap used to be the only one, at eight, on the reasoning
 * that eight is more than a conversation needs. That was true of one
 * conversation. Every member of the WhatsApp group may ask for the desk, so a
 * single number shared across 122 people is a starvation bug waiting for a
 * busy afternoon: eight members ask, the ninth is refused, and nothing tells
 * them why. The tighter cap belongs on the sender, because the runaway this
 * exists to stop — a model in a loop — is one sender by definition.
 *
 * A mint with no sender is still counted against the computer. The control
 * plane cannot tell those apart, so they share the looser bound rather than
 * escaping both.
 */
async function overMintCap(planned: InviteDraft, now: number): Promise<RedeemFailure | undefined> {
  const since = now - MINT_WINDOW_MS;
  if (
    planned.senderHash &&
    (await mintsInWindow(planned.computerId, since, planned.senderHash)) >= SENDER_WINDOW_MAX
  ) {
    return {
      error: "You already have a link open. Use that one, or try again shortly.",
      status: 429,
    };
  }
  return (await mintsInWindow(planned.computerId, since)) >= MINT_WINDOW_MAX
    ? { error: "Too many links for this computer just now. Try again shortly.", status: 429 }
    : undefined;
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
  /** The caller holds a mint secret rather than an operator session. */
  limited = false,
): Promise<MintedInvite | RedeemFailure> {
  const planned = planInvite(input, env, now);
  if ("error" in planned) {
    return planned;
  }
  const capped = limited ? await overMintCap(planned, now) : undefined;
  if (capped) {
    return capped;
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

/** Validate the link and name the computer. Grants no seat: rendering is not redeeming. */
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

type GrantedInvite = (SeatGrant & { computerId: string; hubUrl: string }) | RedeemFailure;

/**
 * Look the link up, grant it a seat on its own computer, remember the seat.
 *
 * Redeem and refresh differ by one thing, `fresh`, and were two copies of this
 * until the empty-token guard existed in one of them and not the other. The
 * guard matters most on the path that mints: `hashInviteToken("")` is a
 * perfectly good hash and would be looked up like any other.
 */
async function grantStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap,
  now: number,
  fresh: boolean,
): Promise<GrantedInvite> {
  const trimmed = token.trim();
  if (!trimmed) {
    return { error: "This link is not valid.", status: 404 };
  }
  const found = await byTokenHash(hashInviteToken(trimmed));
  const inspected = inspectInvite(found, purpose, env, now);
  if ("error" in inspected) {
    return inspected;
  }
  // Refresh drops the role, not the token: an unset role forces a fresh seat,
  // and the old token still rides along so the hub revokes it as it mints the
  // new one.
  const record: InviteRecord = fresh
    ? { ...(found as InviteRecord), seatRole: undefined }
    : (found as InviteRecord);
  const granted = await grantInviteSeat(record, purpose, env, now, issueSeatAsIssuer);
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
        .where(eq(invite.tokenHash, record.tokenHash));
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

export function redeemStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<GrantedInvite> {
  return grantStoredInvite(token, purpose, env, now, false);
}

/** The hub forgot this link's seat: mint another and revoke the one it replaces. */
export function refreshStoredInvite(
  token: string,
  purpose: InvitePurpose,
  env: EnvMap = process.env,
  now = Date.now(),
): Promise<GrantedInvite> {
  return grantStoredInvite(token, purpose, env, now, true);
}
