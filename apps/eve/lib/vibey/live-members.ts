import type { PersonProfile } from "./data/people.ts";
import { bridgeConfigured, bridgeGet } from "./bridge-client.ts";

/**
 * Live VCMC membership from the bridge (`GET /members`): WhatsApp participants
 * merged with the git profile overlay. Returns `null` — never throws — when
 * the bridge is unconfigured, not yet seeded, or the call fails, so callers
 * degrade to the git overlay with no special-casing.
 */

interface MembersResponse {
  members?: PersonProfile[];
  ready?: boolean;
}

/**
 * Current group members as the bridge sees them. `null` means "use git":
 * unconfigured, unreachable, or the live set has not been seeded yet.
 * An empty array is a real answer (the room is empty).
 */
export const fetchLiveMembers = async (): Promise<PersonProfile[] | null> => {
  if (!bridgeConfigured()) {
    return null;
  }
  try {
    const data = await bridgeGet<MembersResponse>("/members");
    if (data.ready === false) {
      return null;
    }
    if (!Array.isArray(data.members)) {
      return null;
    }
    return data.members;
  } catch {
    return null;
  }
};
