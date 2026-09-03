import { sendTargetAllowed } from "./media-send.ts";
import type { DailyCounter, SendTargetGate } from "./media-send.ts";

/**
 * The one outbound envelope: parsing and policy for everything a Bot can write
 * into a chat.
 *
 * There is deliberately no endpoint per verb. A reply, a reaction, an image and
 * a document are one validated shape with one target allowlist and one rate
 * decision, so the day a second network arrives it implements one interface
 * instead of four, and a new verb cannot quietly acquire weaker gating than the
 * verb next to it. `account.ts` owns the Baileys calls; nothing here touches a
 * socket, which is what makes the rules testable without booting one.
 *
 * ```
 * { jid, reply_to?, text?, react?: { to, emoji },
 *   media?: [{ kind: "image" | "document", mime, base64, filename?, caption? }] }
 * ```
 *
 * `reply_to` and `react.to` are short message ids from `message-ids.ts`, never
 * raw WhatsApp keys: the caller can only address a message the bridge has
 * actually seen and handed it.
 */

/** What a media item is: a picture in the chat, or a file with a name on it. */
export type MediaKind = "image" | "document";

export interface EnvelopeMedia {
  kind: MediaKind;
  mime: string;
  base64: string;
  /** Required for a document (WhatsApp renders a file by its name), unused for an image. */
  filename?: string;
  caption?: string;
}

export interface EnvelopeReaction {
  /** Short id of the message being reacted to; must be in the same chat as `jid`. */
  to: string;
  emoji: string;
}

/** A validated outbound envelope. */
export interface SendEnvelope {
  jid: string;
  /** Short id of the message this reply quotes. */
  reply_to?: string;
  text?: string;
  react?: EnvelopeReaction;
  media?: EnvelopeMedia[];
}

/**
 * At most four files in one envelope. A cap exists so a single request cannot
 * turn into an unbounded upload loop holding the account's socket; four is
 * comfortably more than any reply the agent composes today.
 */
export const MAX_MEDIA_ITEMS = 4;

/**
 * Longest emoji accepted, in UTF-16 units. A flag plus a skin tone plus a ZWJ
 * sequence is around eleven; the cap is only here so "react" cannot smuggle a
 * paragraph into a chat through the reaction field, which WhatsApp would
 * render as a wall of text under the message.
 */
const MAX_EMOJI_UNITS = 24;

/** Longest filename kept, matching what WhatsApp itself will display. */
const MAX_FILENAME_CHARS = 120;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A trimmed non-empty string, or undefined. */
const trimmed = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * A filename safe to hand WhatsApp and to write to disk on the far side: no
 * path separators, no control characters, no leading dots. The name is
 * caller-supplied text that ends up as a downloadable file, so it is sanitised
 * here rather than trusted anywhere downstream.
 */
export const sanitiseFilename = (raw: string): string =>
  raw
    .replaceAll(/[/\\]/gu, "_")
    // oxlint-disable-next-line no-control-regex -- stripping control bytes is the point
    .replaceAll(/[\u0000-\u001F\u007F]/gu, "")
    .replace(/^\.+/u, "")
    .trim()
    .slice(0, MAX_FILENAME_CHARS);

/** Validate one media item; returns the item or a one-line reason for the 400. */
const parseMediaItem = (
  raw: unknown,
  index: number,
): { item: EnvelopeMedia } | { error: string } => {
  const at = `media[${index}]`;
  if (!isRecord(raw)) {
    return { error: `${at} must be an object` };
  }
  const { kind } = raw;
  if (kind !== "image" && kind !== "document") {
    return { error: `${at}.kind must be "image" or "document"` };
  }
  const mime = trimmed(raw.mime);
  if (!mime) {
    return { error: `${at}.mime required` };
  }
  if (kind === "image" && !mime.startsWith("image/")) {
    return { error: `${at}.mime must be an image/* type for an image` };
  }
  const base64 = trimmed(raw.base64);
  if (!base64) {
    return { error: `${at}.base64 required` };
  }
  const filename = trimmed(raw.filename);
  // A document with no name shows up in the chat as an untitled file nobody
  // can identify, so it is required rather than defaulted to something invented.
  if (kind === "document" && !(filename && sanitiseFilename(filename))) {
    return { error: `${at}.filename required for a document` };
  }
  return {
    item: {
      base64,
      kind,
      mime,
      ...(filename ? { filename: sanitiseFilename(filename) } : {}),
      ...(trimmed(raw.caption) ? { caption: trimmed(raw.caption) } : {}),
    },
  };
};

/** Validate the `react` field. */
const parseReaction = (raw: unknown): { react: EnvelopeReaction } | { error: string } => {
  if (!isRecord(raw)) {
    return { error: "react must be an object" };
  }
  const to = trimmed(raw.to);
  if (!to) {
    return { error: "react.to required" };
  }
  const emoji = typeof raw.emoji === "string" ? raw.emoji.trim() : "";
  // An empty `text` is how WhatsApp removes a reaction. Removal is not a verb
  // this envelope offers, so an empty emoji is a malformed request rather than
  // a silent no-op the caller would have to guess at.
  if (!emoji) {
    return { error: "react.emoji required" };
  }
  if (emoji.length > MAX_EMOJI_UNITS || /\s/u.test(emoji)) {
    return { error: "react.emoji must be a single emoji" };
  }
  return { react: { emoji, to } };
};

/**
 * Validate an envelope body. Unknown keys are dropped rather than refused, the
 * same contract as the account config, so a newer Bot can talk to an older
 * bridge; anything malformed on a known key is a one-line reason the route
 * turns into a 400.
 */
export const parseSendEnvelope = (
  body: Record<string, unknown>,
): { envelope: SendEnvelope } | { error: string } => {
  const jid = trimmed(body.jid);
  if (!jid) {
    return { error: "jid required" };
  }
  const envelope: SendEnvelope = { jid };

  const replyTo = trimmed(body.reply_to);
  if (body.reply_to !== undefined && body.reply_to !== null && !replyTo) {
    return { error: "reply_to must be a message id" };
  }
  if (replyTo) {
    envelope.reply_to = replyTo;
  }

  const text = trimmed(body.text);
  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") {
    return { error: "text must be a string" };
  }
  if (text) {
    envelope.text = text;
  }

  if (body.react !== undefined && body.react !== null) {
    const parsed = parseReaction(body.react);
    if ("error" in parsed) {
      return parsed;
    }
    envelope.react = parsed.react;
  }

  if (body.media !== undefined && body.media !== null) {
    if (!Array.isArray(body.media)) {
      return { error: "media must be an array" };
    }
    if (body.media.length > MAX_MEDIA_ITEMS) {
      return { error: `media accepts at most ${MAX_MEDIA_ITEMS} items` };
    }
    const media: EnvelopeMedia[] = [];
    for (const [index, raw] of body.media.entries()) {
      const parsed = parseMediaItem(raw, index);
      if ("error" in parsed) {
        return parsed;
      }
      media.push(parsed.item);
    }
    if (media.length > 0) {
      envelope.media = media;
    }
  }

  // An envelope that says nothing is a caller bug, not silence to act on.
  if (!(envelope.text || envelope.react || envelope.media)) {
    return { error: "envelope must carry text, react or media" };
  }
  return { envelope };
};

/**
 * Where the messages an envelope refers to actually live, once resolved.
 *
 * The argument of `authoriseEnvelope`, the gate holding the
 * never-post-to-a-group rule; `EnvelopeLimits` beside it is already exported.
 *
 * @public
 */
export interface EnvelopeTargets {
  /** Chat holding the `reply_to` message; undefined when the id did not resolve. */
  replyToJid?: string;
  /** Chat holding the `react.to` message; undefined when the id did not resolve. */
  reactToJid?: string;
}

/** The two daily budgets an envelope spends. */
export interface EnvelopeLimits {
  /** Every envelope costs one write, whatever it carries. */
  writes: DailyCounter;
  /** Media items additionally spend the per-chat image budget. */
  media: DailyCounter;
}

/**
 * The verdict of `authoriseEnvelope`, and `reason` is the 403 body.
 *
 * @public
 */
export type EnvelopeDecision = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether an envelope may be sent, and spend its budget when it may.
 *
 * The order matters: identity first, then the anchoring rules, then rate, so a
 * refused send never costs the chat a slot it could have used.
 *
 * The group rule is the load-bearing one. `POST /send` refuses group JIDs in
 * code because a Bot must never post to a group on a timer, and an envelope
 * that accepted bare text into a group would be a one-word way around that. So
 * a text write to a group has to be anchored: it must quote a message the
 * bridge saw in that same group, which by construction makes it a reply to
 * something a member said rather than an unprompted broadcast. Reactions are
 * anchored the same way. Media keeps the exemption /send-media already has (a
 * requested image is a reply, not a broadcast), so the envelope subsumes that
 * route without loosening it.
 */
export const authoriseEnvelope = (
  envelope: SendEnvelope,
  targets: EnvelopeTargets,
  gate: SendTargetGate,
  limits: EnvelopeLimits,
): EnvelopeDecision => {
  const { jid } = envelope;
  if (!sendTargetAllowed(jid, gate)) {
    return { ok: false, reason: "jid not allowlisted for sends" };
  }
  if (envelope.reply_to && targets.replyToJid !== jid) {
    return {
      ok: false,
      reason: targets.replyToJid
        ? "reply_to is a message in another chat"
        : "unknown reply_to message id",
    };
  }
  if (envelope.react && targets.reactToJid !== jid) {
    return {
      ok: false,
      reason: targets.reactToJid
        ? "react.to is a message in another chat"
        : "unknown react.to message id",
    };
  }
  if (jid.endsWith("@g.us") && envelope.text && !envelope.reply_to) {
    return {
      ok: false,
      reason: "text into a group must quote a message in it (reply_to)",
    };
  }
  const mediaCount = envelope.media?.length ?? 0;
  // Checked before either is spent: a two-step take could burn the media budget
  // on an envelope the write budget then refuses.
  if (!limits.writes.allows(jid)) {
    return { ok: false, reason: "daily send limit reached for this chat" };
  }
  if (mediaCount > 0 && !limits.media.allows(jid, mediaCount)) {
    return { ok: false, reason: "daily image limit reached for this chat" };
  }
  limits.writes.take(jid);
  if (mediaCount > 0) {
    limits.media.take(jid, mediaCount);
  }
  return { ok: true };
};
