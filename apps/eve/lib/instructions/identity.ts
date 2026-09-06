import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defineDynamic, defineInstructions } from "eve/instructions";

import { tenantDataDir } from "../vibey/chat-archive-source.ts";

/**
 * Who this computer's Bot is, when the tenant has said.
 *
 * `agent/instructions.md` is the generic desk agent every computer boots
 * with. A tenant with a persona of its own (Vibey: a voice, a community, a
 * set of rules about what it never says) puts it in `instructions.md` under
 * the tenant data directory, and this resolver reads it at session start and
 * places it right after the generic file, before the memory block and the
 * owner's runtime edits. Same rule as the archive and the roster: content on
 * the volume, code in the image, and a computer without the file is the
 * generic Bot with nothing added.
 *
 * Read with `fs` and cached per process: the file changes when a person
 * edits it and a restart is how that reaches a turn, the same as the other
 * data files. It deliberately does not go through the hub's runtime
 * configuration, whose 10,000 character ceiling is sized for an owner's
 * notes rather than a persona; that layer stays what hello.expert edits.
 */
export const IDENTITY_FILE = "instructions.md";

let cached: string | null | undefined;

export function tenantIdentity(env: NodeJS.ProcessEnv = process.env): string | null {
  if (cached === undefined) {
    const path = join(tenantDataDir(env), IDENTITY_FILE);
    cached = existsSync(path) ? readFileSync(path, "utf-8").trim() || null : null;
  }
  return cached;
}

/** Test seam: forget the file so the next call re-reads it. */
export const resetIdentityCache = (): void => {
  cached = undefined;
};

export default defineDynamic({
  events: {
    "session.started": () => {
      const identity = tenantIdentity();
      return identity ? defineInstructions({ content: identity }) : null;
    },
  },
});
