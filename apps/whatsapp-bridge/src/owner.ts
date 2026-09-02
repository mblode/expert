import { userPart } from "./trigger.ts";

/**
 * Owner identity matching for the proactive-send allowlist.
 *
 * OWNER_JIDS holds the identities the bridge may PUSH a message to via
 * POST /send and POST /send-media. It used to route the owner's 1:1 DMs to a
 * personal second-brain agent as well; that agent's WhatsApp surface was
 * retired, so this no longer affects where an inbound DM goes. Entries may be
 * a phone in any familiar shape
 * (+61..., 61..., 04...) or a full JID (61...@s.whatsapp.net, 1234...@lid).
 * Modern WhatsApp often presents the sender as an opaque @lid with the real
 * phone only in senderPn, so matching checks BOTH identities the bridge has.
 */

const digits = (s: string | null | undefined): string => (s || "").replaceAll(/\D/gu, "");

/** Parse the OWNER_JIDS env value into a set of normalized (digit) ids. */
export const parseOwnerIds = (raw?: string): Set<string> =>
  new Set(
    (raw || "")
      .split(",")
      .map((entry) => digits(userPart(entry.trim())))
      .filter(Boolean),
  );

/** Whether one identity (JID or phone, any format) matches the owner set. */
const matchesOwner = (owners: Set<string>, id: string | null | undefined): boolean => {
  const d = digits(userPart(id ?? ""));
  if (!d) {
    return false;
  }
  if (owners.has(d)) {
    return true;
  }
  // AU tolerance, mirroring whitelist.isMember: 0-prefixed national form vs
  // 61-prefixed E.164, plus a last-9-digits fallback.
  if (d.startsWith("0") && owners.has(`61${d.slice(1)}`)) {
    return true;
  }
  const last9 = d.slice(-9);
  if (last9.length === 9 && owners.has(`61${last9}`)) {
    return true;
  }
  return false;
};

/**
 * Whether the message sender is the owner. `sender` may be an opaque @lid and
 * `senderPhone` the phone-based identity (from senderPn); either matching is
 * enough, so an OWNER_JIDS with just the phone works on lid-presenting DMs as
 * long as WhatsApp supplies senderPn (add the @lid entry if it ever doesn't).
 */
export const isOwner = (
  owners: Set<string>,
  sender: string | null | undefined,
  senderPhone: string | null | undefined,
): boolean =>
  owners.size > 0 && (matchesOwner(owners, sender) || matchesOwner(owners, senderPhone));
