import type { Member } from "./members.ts";
import { escapeRegExp, userPart } from "./trigger.ts";

/**
 * Mention resolution: WhatsApp bodies carry @-mentions as the raw JID user-part
 * ("@61408461216" or an opaque "@123456@lid" id), the display name a client
 * renders lives only in contextInfo.mentionedJid plus whatever name sources we
 * hold. Left raw, a mention is meaningless to the agent; stripped (the old
 * behaviour), the person vanishes from the sentence entirely ("how many times
 * have I recommended ?"). So: resolve every mention token we can to "@Name",
 * and only remove the bot's own token.
 *
 * Pure and lookup-injected so it unit-tests without the socket or the roster.
 */

/** Resolve a mention user-part (phone digits or lid digits) to a display name. */
export type NameLookup = (user: string) => string | undefined;

/**
 * Phone-digits -> name lookup over the member roster. Roster phones are E.164
 * ("+61408461216") while mention JIDs carry bare digits, so keys are the
 * digits-only form. Covers phone-addressed mentions; @lid mentions resolve via
 * a learned lid->phone pairing layered on top (see composeMentionLookup).
 */
export const memberNameLookup = (members: readonly Member[]): NameLookup => {
  const byDigits = new Map<string, string>();
  for (const m of members) {
    const digits = m.phone.replaceAll(/\D+/gu, "");
    if (digits) {
      byDigits.set(digits, m.name);
    }
  }
  return (user) => byDigits.get(user);
};

/** Sources a composed mention lookup draws on, in priority order. */
export interface MentionSources {
  /** The bot's own id user-parts (phone + lid); these resolve to `botName`. */
  botIds?: ReadonlySet<string> | null;
  botName?: string;
  /** Authoritative roster: name by phone-digits user-part. */
  roster: NameLookup;
  /** Learned phone (digits) for a lid user-part, so a lid can reach the roster. */
  lidPhone?: (user: string) => string | undefined;
  /** Learned pushName for a lid user-part; the fallback for non-members. */
  lidName?: (user: string) => string | undefined;
}

/**
 * Build the mention-token lookup. Priority: the bot's own ids -> its name; then
 * the authoritative roster, hit directly by a phone-form mention or, for a
 * modern opaque @lid mention, via the learned lid->phone pairing; then the
 * pushName we've seen for that lid (covers guests). Preferring the roster over
 * pushName also means a canonical member name wins over whatever display name a
 * user happens to have set. Unknown -> undefined, so the caller leaves the token
 * raw rather than inventing a name.
 */
export const composeMentionLookup =
  ({ botIds, botName, roster, lidPhone, lidName }: MentionSources): NameLookup =>
  (user) => {
    if (botIds?.has(user)) {
      return botName;
    }
    const phone = lidPhone?.(user);
    return roster(user) ?? (phone ? roster(phone) : undefined) ?? lidName?.(user);
  };

/** A learned lid<->phone pairing, with a display name when the source had one. */
export interface LidPair {
  lid: string;
  phone: string;
  name?: string;
}

/**
 * The subset of Baileys' Contact / GroupParticipant shape we read. Group
 * metadata and history-sync contacts both use it: in a lid-addressed group
 * `id` is the @lid and `phoneNumber` the real number; in a pn-addressed group
 * `id` is the number and `lid` carries the @lid. History contacts also bring
 * `name`/`notify`; group participants never do.
 */
export interface ContactLike {
  id?: string | null;
  lid?: string | null;
  phoneNumber?: string | null;
  name?: string | null;
  notify?: string | null;
}

/**
 * Extract lid->phone pairs from group participants or synced contacts, handling
 * both addressing modes. Entries missing either half are skipped, the server
 * doesn't always populate the alternate id, and a one-sided entry can't help
 * mention resolution anyway (passive learning still covers those people).
 */
export const lidPairsFrom = (
  items?: readonly (ContactLike | null | undefined)[] | null,
): LidPair[] => {
  const pairs: LidPair[] = [];
  for (const item of items ?? []) {
    if (!item?.id) {
      continue;
    }
    const name = item.name?.trim() || item.notify?.trim() || undefined;
    let lid = "";
    let phone = "";
    if (item.id.endsWith("@lid")) {
      lid = userPart(item.id);
      phone = userPart(item.phoneNumber ?? "");
    } else if (item.id.endsWith("@s.whatsapp.net")) {
      phone = userPart(item.id);
      lid = userPart(item.lid ?? "");
    }
    if (lid && phone) {
      pairs.push(name ? { lid, name, phone } : { lid, phone });
    }
  }
  return pairs;
};

/**
 * Rewrite the @-mention tokens in `text` against contextInfo.mentionedJid:
 * tokens whose user-part is in `strip` are removed, the rest become "@Name"
 * when `lookup` resolves one, and unknown tokens stay as-is (a raw id is still
 * more signal than a hole in the sentence). Only tokens backed by a mentioned
 * JID are touched, so ordinary text like an email or "@10x" can't be mangled.
 * No mentions or no text -> unchanged.
 */
export const resolveMentions = (
  text: string,
  mentionedJid: readonly (string | null | undefined)[] | null | undefined,
  lookup: NameLookup,
  { strip }: { strip?: ReadonlySet<string> } = {},
): string => {
  if (!text || !mentionedJid || mentionedJid.length === 0) {
    return text;
  }
  // Longest-first so one user-part that prefixes another can't half-match;
  // the (?!\d) guard stops "@614084" matching inside "@61408461216".
  const users = [...new Set(mentionedJid.map((j) => userPart(j)))]
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length);
  let out = text;
  for (const user of users) {
    const token = new RegExp(`@${escapeRegExp(user)}(?!\\d)`, "gu");
    if (strip?.has(user)) {
      out = out.replaceAll(token, "");
      continue;
    }
    const name = lookup(user);
    if (name) {
      // Replacer function so a "$" in a name can't act as a replacement pattern.
      out = out.replaceAll(token, () => `@${name}`);
    }
  }
  return out;
};
