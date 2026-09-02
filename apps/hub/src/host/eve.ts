import { existsSync } from "node:fs";
import { join } from "node:path";
import type { BotConfig } from "../service/bots.ts";

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

/**
 * One Eve process per roster Bot that has an eve.dev project directory
 * (`apps/eve/bots/<id>`). Subagents under a single Eve share one token,
 * that is not "each bot drives its own Eve".
 */
export function planEveLaunches(
  roster: readonly BotConfig[],
  opts: { botsRoot: string; basePort?: number },
): EveLaunch[] {
  const basePort = opts.basePort ?? EVE_BASE_PORT;
  const launches: EveLaunch[] = [];
  for (const bot of roster) {
    const cwd = join(opts.botsRoot, bot.id);
    if (!existsSync(join(cwd, "package.json"))) {
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
