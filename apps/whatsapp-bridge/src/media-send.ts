import { groupAllowed } from "./groups.ts";
import type { GroupGate } from "./groups.ts";
import { userPart } from "./trigger.ts";

/**
 * Pure policy + parsing for outbound sends: payload validation for the legacy
 * `POST /send-media` body, the target allowlist every outbound verb shares, and
 * the per-chat daily rate caps. No socket, no IO, `account.ts` wires these into
 * the actual send so the gating stays unit-testable without booting Baileys.
 *
 * The allowlist and the counters live here rather than next to one route
 * because a second verb (a quoted reply, a reaction, a document, and whatever a
 * second network needs later) must not get to invent its own answer to "may I
 * write into this chat, and how often": `send-envelope.ts` composes both.
 */

/** A validated /send-media payload. */
export interface SendMediaPayload {
  jid: string;
  mime: string;
  base64: string;
  caption?: string;
}

/**
 * Validate a /send-media body. Images only for now (the one media kind the
 * agent generates); returns an error string for anything malformed so the
 * route can 400 it.
 */
export const parseSendMediaBody = (
  body: Record<string, unknown>,
): { payload: SendMediaPayload } | { error: string } => {
  const jid = typeof body.jid === "string" ? body.jid.trim() : "";
  const mime = typeof body.mime === "string" ? body.mime.trim() : "";
  const base64 = typeof body.base64 === "string" ? body.base64.trim() : "";
  if (!jid) {
    return { error: "jid required" };
  }
  if (!mime.startsWith("image/")) {
    return { error: "mime must be an image/* type" };
  }
  if (!base64) {
    return { error: "base64 required" };
  }
  const caption =
    typeof body.caption === "string" && body.caption.trim() ? body.caption.trim() : undefined;
  return { payload: { base64, caption, jid, mime } };
};

/** The identity checks an outbound target is gated on. */
export interface SendTargetGate {
  /** The account's group gate (mirrors message handling). */
  groups: GroupGate;
  /** Member phone check (whitelist.isMember). */
  isMember: (num: string | null | undefined) => boolean;
  /** Owner identity check, already bound to the owner set. */
  isOwnerJid: (jid: string) => boolean;
  maintainerJid?: string;
}

/**
 * Whether an outbound write to `jid` is allowed: anywhere the bot already
 * replies. Groups pass the same allowlist as inbound messages; DMs must be the
 * maintainer, an owner, or a whitelisted member. A member DM keyed by an
 * opaque `@lid` JID (no phone digits) fails the member check and is refused ,
 * the send degrades gracefully agent-side, and group sends (the main use) are
 * unaffected.
 *
 * This is the one target allowlist: /send-media and the send envelope both ask
 * it, so a new verb can never reach a chat the bot would not otherwise write to.
 */
export const sendTargetAllowed = (jid: string, gate: SendTargetGate): boolean => {
  if (!jid) {
    return false;
  }
  if (jid.endsWith("@g.us")) {
    return groupAllowed(gate.groups, jid);
  }
  return (
    Boolean(gate.maintainerJid && jid === gate.maintainerJid) ||
    gate.isOwnerJid(jid) ||
    gate.isMember(userPart(jid))
  );
};

/** A per-key counter that resets when the (UTC) day rolls over. */
export interface DailyCounter {
  /** Whether `n` sends are still available for `key`, consuming nothing. */
  allows: (key: string, n?: number) => boolean;
  /** Consume `n` sends for `key`, all or nothing; false when the day's limit is spent. */
  take: (key: string, n?: number) => boolean;
}

/**
 * Create a per-key daily counter capping outbound writes per chat, so a runaway
 * agent (or anyone holding the bridge secret) can't spam a chat. In-memory by
 * design: a bridge restart resetting the count is fine for a rate cap. `limit`
 * may be a getter so a config change to `image_sends_per_day` or
 * `sends_per_day` applies on the next send without a restart. `today` is
 * injectable for tests.
 */
export const createDailyCounter = (
  limit: number | (() => number),
  today: () => string = () => new Date().toISOString().slice(0, 10),
): DailyCounter => {
  let day = today();
  const counts = new Map<string, number>();
  /** Roll the day over before any read, so a long-lived process resets on time. */
  const used = (key: string): number => {
    const now = today();
    if (now !== day) {
      day = now;
      counts.clear();
    }
    return counts.get(key) ?? 0;
  };
  const room = (key: string, n: number): boolean =>
    used(key) + n <= (typeof limit === "function" ? limit() : limit);
  return {
    allows: (key, n = 1) => room(key, n),
    take(key, n = 1) {
      // All or nothing: one envelope carrying three files must not half-spend
      // the budget and then be refused, which would leave the caller unable to
      // retry the same request cleanly.
      if (!room(key, n)) {
        return false;
      }
      counts.set(key, used(key) + n);
      return true;
    },
  };
};
