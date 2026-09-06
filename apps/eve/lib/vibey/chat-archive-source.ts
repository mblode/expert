import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where a tenant's content lives on the box: `/workspace/.bots/<id>/data/`.
 *
 * This is what makes one build both Vibey and a stranger's assistant. The
 * code is the same on every computer; the VCMC chat archive, the roster and
 * the lore are files on the VCMC computer's volume and absent everywhere
 * else, and every tool that needs them answers `available: false` when the
 * directory is empty rather than inventing a community that is not there.
 * `docs/plans/vibey-on-expert.md` is the decision.
 *
 * Read with `fs`, not through the hub's `ReadFile`: this process runs as the
 * same uid as the box, the directory is box-owned, and a synchronous read at
 * first use is what lets the archive index be built once per process.
 */
export function tenantDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.COMPUTER_BOT_DATA?.trim();
  if (explicit) {
    return explicit;
  }
  const bot = env.COMPUTER_BOT_ID?.trim() || "main";
  return `/workspace/.bots/${bot}/data`;
}

/** The archive as the import script writes it: gzip, then base64, one file. */
export const ARCHIVE_FILE = "chat-archive.b64";

/** The gzip+base64 archive text, or null when this computer has no archive. */
export function readArchiveSource(env: NodeJS.ProcessEnv = process.env): string | null {
  const path = join(tenantDataDir(env), ARCHIVE_FILE);
  if (!existsSync(path)) {
    return null;
  }
  const text = readFileSync(path, "utf-8").trim();
  return text.length > 0 ? text : null;
}
