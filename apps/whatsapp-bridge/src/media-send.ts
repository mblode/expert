import { groupAllowed } from "./groups.ts";
import type { GroupGate } from "./groups.ts";
import { userPart } from "./trigger.ts";

/**
 * Pure policy + parsing for proactive media sends (POST /send-media): payload
 * validation, the target allowlist, and a per-chat daily rate cap. No socket,
 * no IO, index.ts wires these into the actual send so the gating stays
 * unit-testable without booting Baileys.
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

/** The identity checks a media-send target is gated on. */
export interface MediaSendGate {
  /** The account's group gate (mirrors message handling). */
  groups: GroupGate;
  /** Member phone check (whitelist.isMember). */
  isMember: (num: string | null | undefined) => boolean;
  /** Owner identity check, already bound to the owner set. */
  isOwnerJid: (jid: string) => boolean;
  maintainerJid?: string;
}

/**
 * Whether a proactive media send to `jid` is allowed: anywhere the bot already
 * replies. Groups pass the same allowlist as inbound messages; DMs must be the
 * maintainer, an owner, or a whitelisted member. A member DM keyed by an
 * opaque `@lid` JID (no phone digits) fails the member check and is refused ,
 * the send degrades gracefully agent-side, and group sends (the main use) are
 * unaffected.
 */
export const mediaSendAllowed = (jid: string, gate: MediaSendGate): boolean => {
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
  /** Consume one send for `key`; false when the day's limit is spent. */
  take: (key: string) => boolean;
}

/**
 * Create a per-key daily counter capping proactive media sends per chat, so a
 * runaway agent (or anyone holding the bridge secret) can't spam a chat with
 * images. In-memory by design: a bridge restart resetting the count is fine
 * for a rate cap. `limit` may be a getter so a config change to
 * `image_sends_per_day` applies on the next send without a restart. `today`
 * is injectable for tests.
 */
export const createDailyCounter = (
  limit: number | (() => number),
  today: () => string = () => new Date().toISOString().slice(0, 10),
): DailyCounter => {
  let day = today();
  const counts = new Map<string, number>();
  return {
    take(key) {
      const now = today();
      if (now !== day) {
        day = now;
        counts.clear();
      }
      const used = counts.get(key) ?? 0;
      if (used >= (typeof limit === "function" ? limit() : limit)) {
        return false;
      }
      counts.set(key, used + 1);
      return true;
    },
  };
};
