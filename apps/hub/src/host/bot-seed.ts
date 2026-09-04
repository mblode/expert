import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BotProfile } from "@computer/shared";

/**
 * Who a Bot ships as: `agent/profile.json` in its Eve project.
 *
 * The Bot's identity is already a directory of files in git (instructions,
 * skills, schedules), and the name, label, description and mark belong with
 * them: a Bot that arrives with a deploy should introduce itself correctly
 * the first time the roster is read, not appear as its own id until someone
 * opens the settings panel and types.
 *
 * It is a seed, once, and only into an empty profile. `BotState.init` writes
 * it when the box has no `profile.json` for that Bot and never again, so a
 * rename by the human, or by the Bot itself with `write_file`, survives every
 * later deploy. That is the same rule memory and the transcript already
 * follow: what is on the volume is the human's.
 *
 * This lives in `host/` because it reads the image's own filesystem rather
 * than the box's, which is the guest layout question the rest of `host/`
 * owns; the service layer takes it as a function and never learns a path.
 */
export type ProfileSeedReader = (botId: string) => Partial<BotProfile> | undefined;

/**
 * A reader over one Eve bots root. Nested `bots/<id>/agent/profile.json`, or
 * `agent/profile.json` at the root for a standalone project mounted as
 * `main`: the same two layouts `planEveLaunches` accepts.
 */
export function profileSeeds(
  botsRoot: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): ProfileSeedReader {
  return (botId) =>
    parseSeed(read, join(botsRoot, botId, "agent", "profile.json")) ??
    (botId === "main" ? parseSeed(read, join(botsRoot, "agent", "profile.json")) : undefined);
}

/**
 * Missing, unreadable, or not an object: nothing. A seed is a convenience,
 * and a Bot with an unreadable one still boots under its hashed default.
 */
function parseSeed(read: (path: string) => string, path: string): Partial<BotProfile> | undefined {
  let raw: string;
  try {
    raw = read(path);
  } catch {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as Partial<BotProfile>;
  } catch {
    console.warn(`bot seed ${path} is not valid JSON; using the default profile`);
    return undefined;
  }
}
