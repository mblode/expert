import { readFile } from "node:fs/promises";

/**
 * The optional member *profile overlay*: names, LinkedIn, tags, in-chat notes
 * for people the tenant already knows, keyed by `phone` (E.164). It is not who
 * is in the WhatsApp group right now; that live set is `live-members.ts` and is
 * what gates DMs. The overlay only enriches: a live participant with a matching
 * row gets that row's name and profile, one without it shows as unidentified.
 *
 * The bridge used to ship one tenant's overlay as a TypeScript array in the
 * repo. Tenant content does not belong in the generic bridge, so the overlay
 * is now a JSON file named by the account's `members_overlay_file` config
 * (`[{ phone, name, tags, ... }]`, same shape as `Member`), reloaded whenever
 * that config changes. No file, or an unreadable one, means an empty overlay.
 */

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

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * Keep a row only when it has the two fields the merge needs (phone + name);
 * `tags` defaults to empty so a hand-written file need not carry it. Extra
 * fields ride through untouched: the Bot's who-is tooling reads them, the
 * bridge does not.
 */
export const parseMembers = (raw: unknown): Member[] => {
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

/** Read and parse an overlay file; a missing or malformed file is an empty overlay. */
export const loadMembersOverlay = async (
  file: string | null | undefined,
  onError?: (error: unknown) => void,
): Promise<Member[]> => {
  if (!file) {
    return [];
  }
  try {
    return parseMembers(JSON.parse(await readFile(file, "utf-8")));
  } catch (error) {
    onError?.(error);
    return [];
  }
};
