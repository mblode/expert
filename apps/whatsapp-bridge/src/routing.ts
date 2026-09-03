import { isOwner } from "./owner.ts";
import type { Whitelist } from "./whitelist.ts";

/**
 * Per-message DM gate.
 *
 * Every group message is answered (a group is already invite-only, and the
 * trigger mode decides which messages reach the Bot). A DM is answered by the
 * account's `dm_policy`:
 *
 * - `members`: the sender is in the live participant set of an allowed group.
 *   This is the historical rule: a joiner can DM before anyone edits an
 *   overlay, a leaver is dropped immediately, and until the live set has been
 *   loaded or seeded the gate fails open. The owner is answered because they
 *   are in the group, not because of any exemption; dropping them from the
 *   group silently stops the Bot answering them, and the test pins that.
 * - `allowlist`: the sender matches `dm_allowlist` (phone in any format or a
 *   full JID, the same matcher as the owner set).
 * - `anyone`: every DM.
 *
 * The account's own self-chat is answered under every policy: it is the
 * linked number's personal console, and you are messaging your own number.
 * Extracted as a pure function so the gate is unit-testable without Baileys.
 */

export interface DmPolicy {
  dm_policy: "members" | "allowlist" | "anyone";
  /** Normalised digit ids from `parseOwnerIds`, for the `allowlist` policy. */
  dmAllowlist: Set<string>;
}

interface ShouldReplyArgs {
  isDM: boolean;
  /** True for the bridge account's own "message yourself" chat. */
  isSelfChat: boolean;
  sender: string;
  senderPhone: string | null;
  whitelist: Whitelist;
  policy: DmPolicy;
}

/** Whether a triggered message should be answered at all. */
export const shouldReply = ({
  isDM,
  isSelfChat,
  sender,
  senderPhone,
  whitelist,
  policy,
}: ShouldReplyArgs): boolean => {
  if (isSelfChat) {
    return true;
  }
  if (!isDM) {
    return true;
  }
  if (policy.dm_policy === "anyone") {
    return true;
  }
  if (policy.dm_policy === "allowlist") {
    return isOwner(policy.dmAllowlist, sender, senderPhone);
  }
  // Check both identities: modern WhatsApp often presents the sender as an
  // opaque @lid with the real phone only in senderPn. Either matching the
  // live set is enough.
  return !whitelist.ready() || whitelist.isMember(senderPhone) || whitelist.isMember(sender);
};
