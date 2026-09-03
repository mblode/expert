import type { Member } from "./members.ts";
import type { ContactLike } from "./mentions.ts";
import { userPart } from "./trigger.ts";

/**
 * Live WhatsApp group membership, persisted in the account data directory next to
 * `lidmap.json`. This is who is in the room *right now* (phone + lid +
 * pushName). The optional members overlay (`members.ts`, a JSON file named by
 * the account config) stays the profile overlay, names, LinkedIn, tags,
 * in-chat notes, and is merged on by phone digits. A joiner appears here
 * before anyone edits the overlay; a leaver drops off even if their overlay
 * row remains.
 */

/** One person currently in a WhatsApp group. At least one of phone/lid is set. */
interface LiveParticipant {
  /** Bare phone digits (no +), when WhatsApp gave a PN identity. */
  phone?: string;
  /** Opaque lid user-part, when WhatsApp gave a lid identity. */
  lid?: string;
  /** Last pushName (or group-metadata name) we have seen for them. */
  name?: string;
}

/** Persisted shape: group JID → current participants. */
type ParticipantsByGroup = Record<string, LiveParticipant[]>;

/** Overlay profile plus optional live lid, as GET /members returns it. */
export type LiveMember = Member & { lid?: string };

/** Digit-only form of a phone (or a JID that happens to contain one). */
export const phoneDigits = (s: string | null | undefined): string =>
  (s || "").replaceAll(/\D/gu, "");

/**
 * AU-tolerant phone equality, matching `whitelist.ts` / `owner.ts`: exact
 * digits, 0-prefixed national vs 61-prefixed E.164, or last-9 fallback.
 */
export const phonesMatch = (a: string, b: string): boolean => {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!(da && db)) {
    return false;
  }
  if (da === db) {
    return true;
  }
  if (da.startsWith("0") && db === `61${da.slice(1)}`) {
    return true;
  }
  if (db.startsWith("0") && da === `61${db.slice(1)}`) {
    return true;
  }
  const last9a = da.slice(-9);
  const last9b = db.slice(-9);
  return last9a.length === 9 && last9a === last9b;
};

/** Same person? Phone match wins; otherwise both lids must be present and equal. */
export const samePerson = (a: LiveParticipant, b: LiveParticipant): boolean => {
  if (a.phone && b.phone && phonesMatch(a.phone, b.phone)) {
    return true;
  }
  return Boolean(a.lid && b.lid && a.lid === b.lid);
};

/** Merge two sightings of the same person, preferring newly-learned fields. */
const mergePerson = (cur: LiveParticipant, next: LiveParticipant): LiveParticipant => ({
  lid: next.lid || cur.lid,
  name: next.name?.trim() || cur.name,
  phone: next.phone || cur.phone,
});

/** `+` + digits, so overlay merge and who-is see an E.164-looking phone. */
export const toE164 = (phone: string): string => {
  const d = phoneDigits(phone);
  return d ? `+${d}` : "";
};

const parseParticipant = (item: unknown): LiveParticipant | null => {
  if (!item || typeof item !== "object") {
    return null;
  }
  const o = item as Record<string, unknown>;
  const phone = typeof o.phone === "string" ? phoneDigits(o.phone) : "";
  const lid = typeof o.lid === "string" ? o.lid.trim() : "";
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!(phone || lid)) {
    return null;
  }
  return {
    ...(lid ? { lid } : {}),
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
  };
};

/**
 * Parse a stored `participants.json` payload. Malformed files / entries become
 * `{}` / dropped rows rather than throwing, same contract as the lid map.
 */
export const parseParticipants = (raw: unknown): ParticipantsByGroup => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: ParticipantsByGroup = {};
  for (const [jid, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const people: LiveParticipant[] = [];
    for (const item of list) {
      const parsed = parseParticipant(item);
      if (parsed) {
        people.push(parsed);
      }
    }
    if (people.length > 0) {
      out[jid] = people;
    }
  }
  return out;
};

/** One JID string (`614…@s.whatsapp.net` or `123@lid`) → a participant. */
export const participantFromJid = (jid: string | null | undefined): LiveParticipant | null => {
  if (!jid) {
    return null;
  }
  const user = userPart(jid);
  if (!user) {
    return null;
  }
  if (jid.includes("@lid")) {
    return { lid: user };
  }
  if (jid.includes("@s.whatsapp.net") || jid.includes("@c.us")) {
    return { phone: user };
  }
  return null;
};

const participantFrom = (item: string | ContactLike | null | undefined): LiveParticipant | null => {
  if (!item) {
    return null;
  }
  if (typeof item === "string") {
    return participantFromJid(item);
  }
  if (!item.id) {
    return participantFromJid(item.phoneNumber ?? item.lid ?? "");
  }
  const name = item.name?.trim() || item.notify?.trim() || undefined;
  let lid = "";
  let phone = "";
  if (item.id.endsWith("@lid")) {
    lid = userPart(item.id);
    phone = userPart(item.phoneNumber ?? "");
  } else if (item.id.endsWith("@s.whatsapp.net") || item.id.endsWith("@c.us")) {
    phone = userPart(item.id);
    lid = userPart(item.lid ?? "");
  } else {
    return participantFromJid(item.id);
  }
  if (!(lid || phone)) {
    return null;
  }
  return {
    ...(lid ? { lid } : {}),
    ...(name ? { name } : {}),
    ...(phone ? { phone } : {}),
  };
};

/**
 * Extract live participants from group metadata, an add/remove event, or a
 * mixed list. Unlike `lidPairsFrom`, one-sided entries (phone-only, lid-only,
 * or a raw JID string) are kept, membership only needs one identity.
 */
export const participantsFrom = (
  items?: readonly (string | ContactLike | null | undefined)[] | null,
): LiveParticipant[] => {
  const out: LiveParticipant[] = [];
  for (const item of items ?? []) {
    const parsed = participantFrom(item);
    if (parsed) {
      out.push(parsed);
    }
  }
  return out;
};

/** Drop the bot (and any other excluded ids) from a participant list. */
export const excludeIds = (
  people: readonly LiveParticipant[],
  ids: ReadonlySet<string>,
): LiveParticipant[] => {
  if (ids.size === 0) {
    return [...people];
  }
  return people.filter((p) => {
    if (p.phone && ids.has(phoneDigits(p.phone))) {
      return false;
    }
    return !(p.lid && ids.has(p.lid));
  });
};

/**
 * Effective membership: live WhatsApp participants, overlay profiles merged on by
 * phone digits. Live-only people become an unidentified stub (pushName + tags).
 * Overlay-only people (left the group) are omitted.
 */
export const mergeWithOverlay = (
  live: readonly LiveParticipant[],
  overlay: readonly Member[],
): LiveMember[] =>
  live
    .map((p) => {
      const profile = p.phone
        ? overlay.find((m) => phonesMatch(m.phone, p.phone ?? ""))
        : undefined;
      if (profile) {
        return p.lid ? { ...profile, lid: p.lid } : { ...profile };
      }
      const name = p.name?.trim() || "Unknown member";
      return {
        name,
        phone: p.phone ? toE164(p.phone) : "",
        tags: ["unidentified"],
        ...(p.lid ? { lid: p.lid } : {}),
      };
    })
    .toSorted((a, b) => a.name.localeCompare(b.name));

/**
 * Compact context block for a group turn so the Bot can see the current room
 * without a tool call. Unidentified (live-only) names are starred.
 */
export const formatMemberContext = (members: readonly LiveMember[]): string | null => {
  if (members.length === 0) {
    return null;
  }
  const names = members.map((m) => (m.tags.includes("unidentified") ? `${m.name}*` : m.name));
  return `Current WhatsApp group members (${members.length}; * = not yet in the profile overlay):\n${names.join(", ")}`;
};

/** In-memory live roster: per-group upsert/remove/replace, dirty flag, seed. */
interface LiveRoster {
  all: () => LiveParticipant[];
  clearDirty: () => void;
  dirty: () => boolean;
  /** Forget a group entirely (it left the allowlist, or the Bot left it). */
  dropGroup: (jid: string) => void;
  lids: () => string[];
  load: (saved: ParticipantsByGroup) => void;
  markDirty: () => void;
  markSeeded: () => void;
  phones: () => string[];
  ready: () => boolean;
  remove: (jid: string, person: LiveParticipant) => void;
  replaceGroup: (jid: string, people: readonly LiveParticipant[]) => void;
  snapshot: () => ParticipantsByGroup;
  touchName: (
    phone: string | null | undefined,
    lid: string | null | undefined,
    name: string | null | undefined,
  ) => void;
  upsert: (jid: string, person: LiveParticipant) => void;
}

const personKey = (p: LiveParticipant): string =>
  p.phone ? `p:${phoneDigits(p.phone)}` : `l:${p.lid ?? ""}`;

const dedupe = (people: readonly LiveParticipant[]): LiveParticipant[] => {
  const out: LiveParticipant[] = [];
  for (const p of people) {
    if (!p.phone && !p.lid) {
      continue;
    }
    const i = out.findIndex((x) => samePerson(x, p));
    if (i === -1) {
      out.push({ ...p });
    } else {
      out[i] = mergePerson(out[i]!, p);
    }
  }
  return out;
};

export const createLiveRoster = (): LiveRoster => {
  let byGroup: ParticipantsByGroup = {};
  let seeded = false;
  let isDirty = false;

  const mark = (): void => {
    isDirty = true;
  };

  const all = (): LiveParticipant[] => {
    const seen = new Set<string>();
    const out: LiveParticipant[] = [];
    for (const people of Object.values(byGroup)) {
      for (const p of people) {
        const key = personKey(p);
        if (!key.endsWith(":") && !seen.has(key)) {
          seen.add(key);
          out.push(p);
        }
      }
    }
    return out;
  };

  return {
    all,
    clearDirty() {
      isDirty = false;
    },
    dirty: () => isDirty,
    dropGroup(jid) {
      if (jid in byGroup) {
        const { [jid]: _dropped, ...rest } = byGroup;
        byGroup = rest;
        mark();
      }
    },
    lids: () => all().flatMap((p) => (p.lid ? [p.lid] : [])),
    load(saved) {
      byGroup = structuredClone(saved);
      if (Object.values(byGroup).some((g) => g.length > 0)) {
        seeded = true;
      }
    },
    markDirty() {
      isDirty = true;
    },
    markSeeded() {
      seeded = true;
    },
    phones: () => all().flatMap((p) => (p.phone ? [phoneDigits(p.phone)] : [])),
    ready: () => seeded,
    remove(jid, person) {
      const group = byGroup[jid];
      if (!group) {
        return;
      }
      const next = group.filter((p) => !samePerson(p, person));
      if (next.length !== group.length) {
        byGroup[jid] = next;
        mark();
      }
    },
    replaceGroup(jid, people) {
      byGroup[jid] = dedupe(people);
      mark();
    },
    snapshot: () => structuredClone(byGroup),
    touchName(phone, lid, name) {
      const n = name?.trim();
      if (!n) {
        return;
      }
      const probe: LiveParticipant = {
        ...(lid ? { lid } : {}),
        ...(phone ? { phone: phoneDigits(phone) } : {}),
      };
      if (!probe.phone && !probe.lid) {
        return;
      }
      for (const group of Object.values(byGroup)) {
        for (const p of group) {
          if (samePerson(p, probe) && p.name !== n) {
            p.name = n;
            mark();
          }
        }
      }
    },
    upsert(jid, person) {
      if (!person.phone && !person.lid) {
        return;
      }
      const incoming: LiveParticipant = {
        ...(person.lid ? { lid: person.lid } : {}),
        ...(person.name?.trim() ? { name: person.name.trim() } : {}),
        ...(person.phone ? { phone: phoneDigits(person.phone) } : {}),
      };
      const group = byGroup[jid] ?? [];
      const i = group.findIndex((p) => samePerson(p, incoming));
      if (i === -1) {
        group.push(incoming);
      } else {
        group[i] = mergePerson(group[i]!, incoming);
      }
      byGroup[jid] = group;
      mark();
    },
  };
};
