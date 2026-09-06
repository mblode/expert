/**
 * The tenant's member *profile overlay*: names, LinkedIn, tags, in-chat notes
 * for people the community already knows, keyed by `phone` (E.164).
 *
 * It is a file on the tenant's volume, `members.json` under
 * `tenantDataDir()`, and not a constant in the build, for the reason every
 * VCMC fact left the code on 2026-09-06: the same image runs every computer,
 * and what makes one of them Vibey is what is on its disk. A computer with no
 * file has no members, and `who-is` says so rather than inventing a roster.
 *
 * It is not who is in the WhatsApp group right now: that live set is on the
 * bridge (`GET /members`, `live-members.ts`) and is what gates DMs and what
 * `who-is` prefers when the bridge is reachable. A new joiner appears as
 * unidentified (phone + pushName) until someone fills a row in the file.
 *
 * The shape and the parser are the bridge's (`apps/whatsapp-bridge/src/
 * members.ts`), restated: the bridge is a separate workspace and not a
 * dependency of this one, and it re-validates the same file on its own side.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tenantDataDir } from "../chat-archive-source.ts";

export interface Member {
  /** E.164 phone number: the unique member id and the overlay merge key. */
  phone: string;
  name: string;
  aliases?: string[];
  /** Defaults to true; `false` marks a non-member contact. */
  member?: boolean;
  role?: string;
  org?: string;
  location?: string;
  joined?: string;
  focus?: string;
  inChat?: string[];
  linkedin?: string;
  github?: string;
  x?: string;
  links?: string[];
  tags: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** A member profile. Phone (E.164) is the unique id. */
export type PersonProfile = Member;

/** The overlay as the seed script writes it: a JSON array of `Member`. */
export const MEMBERS_FILE = "members.json";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * Keep a row only when it has the two fields a match needs (phone + name);
 * `tags` defaults to empty so a hand-written file need not carry it. Extra
 * fields ride through untouched.
 */
const parseMembers = (raw: unknown): Member[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: Member[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const o = item as Record<string, unknown>;
    const phone = typeof o.phone === "string" ? o.phone.trim() : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!(phone && name)) {
      continue;
    }
    out.push({
      ...(o as Partial<Member>),
      name,
      phone,
      tags: isStringArray(o.tags) ? o.tags : [],
    });
  }
  return out;
};

let cached: PersonProfile[] | null = null;

/**
 * Every profile in the overlay, members and flagged non-members alike. Read
 * once per process: the file changes when a person edits it, and a restart
 * (or `resetPeopleCache` in a test) is how that edit reaches a turn. A
 * missing or malformed file is an empty overlay, never a throw, because a
 * bad row in a data file must not take the Bot down with it.
 */
export const people = (): PersonProfile[] => {
  if (!cached) {
    const path = join(tenantDataDir(), MEMBERS_FILE);
    if (existsSync(path)) {
      try {
        cached = parseMembers(JSON.parse(readFileSync(path, "utf-8")));
      } catch {
        cached = [];
      }
    } else {
      cached = [];
    }
  }
  return cached;
};

/** Test seam: forget the parsed overlay so the next call re-reads the file. */
export const resetPeopleCache = (): void => {
  cached = null;
};

/** Members only (non-member contacts, if any, are excluded). */
export const memberProfiles = (): PersonProfile[] => people().filter((p) => p.member !== false);

/** Current-member display names, derived from the overlay (no hand-kept list). */
export const memberNames = (): string[] => memberProfiles().map((p) => p.name);
