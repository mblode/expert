import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig } from "../service/bots.ts";

/** Volume-hosted Eve tree. When populated, it replaces the image bots. */
export const DEFAULT_EVE_OVERLAY = "/workspace/eve/bots";

/** First Eve listens here; display N uses base + (N - 1). */
const EVE_BASE_PORT = 2000;

/** Header the hub injects so `eve start` will accept the proxied request. */
export const EVE_HUB_SECRET_HEADER = "x-computer-eve-secret";

/** Optional client hint: which Bot's Eve to talk to. Absent = primary. */
const EVE_BOT_HEADER = "x-computer-bot";

export function evePortForDisplay(display: number, basePort = EVE_BASE_PORT): number {
  return basePort + display - 1;
}

export function eveUrlForDisplay(display: number, basePort = EVE_BASE_PORT): string {
  return `http://127.0.0.1:${evePortForDisplay(display, basePort)}`;
}

export interface EveLaunch {
  botId: string;
  display: number;
  port: number;
  cwd: string;
  token: string;
}

export function isEveProject(dir: string, exists: (path: string) => boolean = existsSync): boolean {
  return exists(join(dir, "package.json")) && exists(join(dir, "agent"));
}

/**
 * Prefer a volume overlay when it has an Eve tree, else COMPUTER_EVE_BOTS,
 * else the image bots. vcmc-agent is a standalone Eve app (agent/ at root),
 * not apps/eve/bots/main, so either layout counts as populated.
 */
export function resolveEveBotsRoot(opts: {
  envBots?: string;
  overlay?: string;
  imageBots: string;
  exists?: (path: string) => boolean;
}): string {
  const exists = opts.exists ?? existsSync;
  const overlay = opts.overlay ?? DEFAULT_EVE_OVERLAY;
  if (exists(join(overlay, "main", "package.json")) || isEveProject(overlay, exists)) {
    return overlay;
  }
  return opts.envBots ?? opts.imageBots;
}

/** Nested `bots/<id>` or, for roster `main`, a standalone Eve project at botsRoot. */
export function eveProjectCwd(
  botsRoot: string,
  botId: string,
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const nested = join(botsRoot, botId);
  if (exists(join(nested, "package.json"))) {
    return nested;
  }
  if (botId === "main" && isEveProject(botsRoot, exists)) {
    return botsRoot;
  }
  return undefined;
}

/**
 * One Eve process per roster Bot that has an eve.dev project directory
 * (`apps/eve/bots/<id>`, a tenant overlay, or a standalone Eve app for
 * `main`). Subagents under a single Eve share one token, that is not
 * "each bot drives its own Eve".
 */
export function planEveLaunches(
  roster: readonly BotConfig[],
  opts: { botsRoot: string; basePort?: number; exists?: (path: string) => boolean },
): EveLaunch[] {
  const basePort = opts.basePort ?? EVE_BASE_PORT;
  const exists = opts.exists ?? existsSync;
  const launches: EveLaunch[] = [];
  for (const bot of roster) {
    const cwd = eveProjectCwd(opts.botsRoot, bot.id, exists);
    if (!cwd) {
      continue;
    }
    launches.push({
      botId: bot.id,
      cwd,
      display: bot.display,
      port: evePortForDisplay(bot.display, basePort),
      token: bot.token,
    });
  }
  return launches;
}

export function pickEveBotId(
  req: { headers: Record<string, string | string[] | undefined>; url?: string },
  primaryId: string,
): string {
  const header = req.headers[EVE_BOT_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader?.trim()) {
    return fromHeader.trim();
  }
  try {
    const bot = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("bot");
    if (bot?.trim()) {
      return bot.trim();
    }
  } catch {
    /* ignore */
  }
  return primaryId;
}
