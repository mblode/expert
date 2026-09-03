import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Supervisor } from "./supervisor.ts";
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

export interface EveChildOptions {
  hubUrl: string;
  eveSecret: string;
  /** Per-Bot logs land here as `eve-<botId>.log`. */
  logDir: string;
  /** Base environment for the child. The guest hands in a filtered one. */
  env?: NodeJS.ProcessEnv;
  /** Run each Eve as this user. The supervisor only honours it as root. */
  uid?: number;
  gid?: number;
}

/**
 * A Bot's Eve gets its own token and the shared hub secret; the rest of the
 * environment is whatever the caller decided a child may see. The guest
 * filters out the setup code and the bridge secret before it gets here,
 * because Eve shares uid box with the model's `shell`.
 */
export function eveChildEnv(
  launch: EveLaunch,
  opts: Pick<EveChildOptions, "hubUrl" | "eveSecret" | "env">,
): NodeJS.ProcessEnv {
  return {
    ...opts.env,
    COMPUTER_BOT_TOKEN: launch.token,
    COMPUTER_EVE_SECRET: opts.eveSecret,
    COMPUTER_URL: opts.hubUrl,
    HOST: "127.0.0.1",
    PORT: String(launch.port),
  };
}

/**
 * Register one supervised `eve start` per launch, loopback only. The single
 * place a Bot's Eve is started: the guest's PID 1 (`init.ts`) and the local
 * `npm run up` (`eves.ts`) both come through here, so a dev gets the same
 * restart backoff, the same `/eve/v1/health` probe and the same child
 * environment as production instead of a detached process nobody watches.
 */
export function superviseEves(
  sup: Pick<Supervisor, "start">,
  launches: readonly EveLaunch[],
  opts: EveChildOptions,
): void {
  for (const launch of launches) {
    sup.start({
      args: ["eve", "start", "--host", "127.0.0.1", "--port", String(launch.port)],
      cmd: "npx",
      cwd: launch.cwd,
      env: eveChildEnv(launch, opts),
      gid: opts.gid,
      healthUrl: `http://127.0.0.1:${launch.port}/eve/v1/health`,
      id: `eve-${launch.botId}`,
      log: join(opts.logDir, `eve-${launch.botId}.log`),
      uid: opts.uid,
    });
  }
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
