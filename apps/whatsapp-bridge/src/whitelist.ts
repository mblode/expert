import type { Logger } from "pino";

import { phoneDigits } from "./live-members.ts";

/**
 * Member allowlist for 1:1 DMs (the `members` DM policy).
 *
 * Membership is the live WhatsApp participant set (phone + lid), not the git
 * overlay file. A joiner is admitted as soon as the bridge sees
 * them in the group; a leaver is dropped immediately, even if their profile
 * row is still in git. The overlay is for names/LinkedIn/notes, not the gate.
 *
 * Numbers are compared on digits so they line up with WhatsApp phone JIDs
 * (`61...@s.whatsapp.net`). Lids are exact. Group messages are not gated
 * (a group is already invite-only). Until the live set has been
 * loaded or seeded, `ready()` is false and `shouldReply` fails open.
 */

/** Live identities the DM gate reads. Getters so a seed after boot is seen. */
export interface LiveAllowlist {
  lids: () => Iterable<string>;
  phones: () => Iterable<string>;
  ready: () => boolean;
}

/** The allowlist surface: membership check plus a readiness flag. */
export interface Whitelist {
  isMember: (num: string | null | undefined) => boolean;
  ready: () => boolean;
}

const phoneIn = (d: string, phones: Set<string>): boolean => {
  if (phones.has(d)) {
    return true;
  }
  // AU tolerance: 0-prefixed national form vs 61-prefixed E.164.
  if (d.startsWith("0") && phones.has(`61${d.slice(1)}`)) {
    return true;
  }
  const last9 = d.slice(-9);
  return last9.length === 9 && phones.has(`61${last9}`);
};

export const createWhitelist = (logger: Logger, live: LiveAllowlist): Whitelist => {
  logger.info("member allowlist bound to the live participant set");
  return {
    isMember(num) {
      const d = phoneDigits(num);
      if (!d) {
        return false;
      }
      if (phoneIn(d, new Set(live.phones()))) {
        return true;
      }
      // Opaque @lid DMs: the live set stores lid user-parts as well as phones.
      const lids = new Set(live.lids());
      return lids.has(d) || lids.has(num?.trim() ?? "");
    },
    ready: () => live.ready(),
  };
};
