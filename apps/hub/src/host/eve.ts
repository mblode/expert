import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Supervisor } from "./supervisor.ts";
import type { BotConfig } from "../service/bots.ts";

/** Volume-hosted Eve tree. When populated, it replaces the image bots. */
export const DEFAULT_EVE_OVERLAY = "/workspace/eve/bots";

/** First Eve listens here; display N uses base + (N - 1). */
const EVE_BASE_PORT = 2000;

/** Header the hub injects so `eve start` will accept the proxied request. */

/** Optional client hint: which Bot's Eve to talk to. Absent = primary. */
const EVE_BOT_HEADER = "x-computer-bot";

export function evePortForDisplay(display: number, basePort = EVE_BASE_PORT): number {
  return basePort + display - 1;
}

export function eveUrlForDisplay(display: number, basePort = EVE_BASE_PORT): string {
  return `http://127.0.0.1:${evePortForDisplay(display, basePort)}`;
}

interface EveLaunch {
  botId: string;
  display: number;
  port: number;
  cwd: string;
  token: string;
}

function isEveProject(dir: string, exists: (path: string) => boolean = existsSync): boolean {
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

/**
 * The project every Bot made at runtime runs.
 *
 * A Bot shipped by the build is a directory: its instructions, its skills and
 * its schedules are files in git. A Bot made from `Seat.CreateBot` has no
 * directory and cannot be given one without a deploy, so it runs this one.
 * That is not a stub: a Bot's identity is its profile, and the template reads
 * the name, the label and the description off `/workspace/.bots/<id>` at the
 * start of every turn (`agent/instructions/profile.ts`, which is why
 * `COMPUTER_BOT_ID` is in the child's environment), so two Bots on this
 * project are two different agents. What they share is their code, which is
 * the part a person was never editing anyway.
 *
 * It is deliberately not a roster row of its own (`eveProjectIds` skips it):
 * a template that shows up in the sidebar as a Bot called "template" is a
 * Bot nobody made and nobody wants.
 */
const TEMPLATE_PROJECT = "template";

/**
 * Nested `bots/<id>`, the template for a Bot made at runtime, or, for roster
 * `main`, a standalone Eve project at botsRoot.
 */
function eveProjectCwd(
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
  const template = join(botsRoot, TEMPLATE_PROJECT);
  if (botId !== TEMPLATE_PROJECT && exists(join(template, "package.json"))) {
    return template;
  }
  return undefined;
}

/**
 * Every Bot this tree ships a project for, sorted, `main` first.
 *
 * The roster is what the hub mounts, and the project directory is what makes
 * a Bot able to think, so a project with no roster row is a Bot that exists
 * in git and nowhere else. `ensureRoster` uses this to mint the missing rows,
 * which is what makes adding a Bot a deploy rather than a deploy plus seven
 * RPCs against the running guest.
 *
 * A standalone Eve app at the root (a tenant overlay) is `main`, the same
 * layout `eveProjectCwd` accepts.
 */
export function eveProjectIds(
  botsRoot: string,
  opts: { exists?: (path: string) => boolean; readdir?: (path: string) => string[] } = {},
): string[] {
  const exists = opts.exists ?? existsSync;
  const readdir =
    opts.readdir ??
    ((path: string) =>
      readdirSync(path, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name));
  if (isEveProject(botsRoot, exists)) {
    return ["main"];
  }
  let names: string[];
  try {
    names = readdir(botsRoot);
  } catch {
    return [];
  }
  // The same test `eveProjectCwd` applies to a nested project, so the rows
  // this mints and the Eves the supervisor launches are the same set. A row
  // with no Eve behind it is a Bot that answers DAEMON_DOWN.
  const ids = names
    .filter((name) => name !== TEMPLATE_PROJECT && exists(join(botsRoot, name, "package.json")))
    .toSorted((a, b) => a.localeCompare(b));
  // `main` is the primary Bot and owns display 1, so it is claimed first when
  // a fresh roster is seeded from an image that ships several projects.
  return ids.includes("main") ? ["main", ...ids.filter((id) => id !== "main")] : ids;
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

interface EveChildOptions {
  hubUrl: string;
  eveSecret: string;
  /** Per-Bot logs land here as `eve-<botId>.log`. */
  logDir: string;
  /** Base environment for the child. The guest hands in a filtered one. */
  env?: NodeJS.ProcessEnv;
  /** Run each Eve as this user. The supervisor only honours it as root. */
  uid?: number;
  gid?: number;
  /** Injected in tests; production asks the real filesystem for the build. */
  exists?: (path: string) => boolean;
  /**
   * Which Bots are registered asleep rather than started. A sleeping Bot has
   * no Eve process at all until something asks for it (`host/wake.ts`), which
   * is what lets eight of them share a 2 GB guest.
   */
  lazy?: (botId: string) => boolean;
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
    // Which Bot this is, in the clear. The token is the identity on the wire
    // and the hub never hands it back a name, so without this a Bot made at
    // runtime cannot find its own profile and the template project has no way
    // to know which of several agents it is being.
    COMPUTER_BOT_ID: launch.botId,
    COMPUTER_BOT_TOKEN: launch.token,
    COMPUTER_EVE_SECRET: opts.eveSecret,
    COMPUTER_URL: opts.hubUrl,
    HOST: "127.0.0.1",
    PORT: String(launch.port),
  };
}

/** What `eve build` leaves behind, and what production actually runs. */
const BUILT_SERVER = join(".output", "server", "index.mjs");

/**
 * How to start one Bot's Eve: the built server directly when there is one,
 * `npx eve start` when there is not.
 *
 * This is the difference between one Bot fitting on this box and three. `npx
 * eve start` is three processes for one agent: the npm shim (95 MB), the eve
 * CLI that supervises the build (367 MB), and the server that answers
 * requests (224 MB), measured idle on the built QA project. Running the
 * server the CLI would have run is 224 MB and boots in about 0.7s, so a
 * roster of eight costs 1.8 GB instead of 5.5 GB, and the guest has 2 GB.
 * Schedules are not lost with it: croner and the `eve*.schedule` modules are
 * in the bundle and fire there, which was checked against a one minute cron
 * before this was written, not assumed. Sandbox templates are: `eve start`
 * runs `prewarmBuiltAppSandboxes` before it spawns this same file, and a
 * bundled server never provisions one on demand, so each Bot's `build` script
 * runs `apps/eve/prewarm.mjs` after `eve build` to ship the template in the
 * image (found 2026-09-06, when the first tenant-skill turn died with
 * SandboxTemplateNotProvisionedError and looked like a model timeout).
 *
 * The fallback is for a dev who has not run `eve build`: `npm run up` on a
 * fresh checkout still works, one process heavier. The guest image builds
 * every Bot, so it never takes that path.
 */
function eveChildCommand(
  cwd: string,
  port: number,
  exists: (path: string) => boolean = existsSync,
): { cmd: string; args: string[] } {
  return exists(join(cwd, BUILT_SERVER))
    ? { args: [BUILT_SERVER], cmd: process.execPath }
    : { args: ["eve", "start", "--host", "127.0.0.1", "--port", String(port)], cmd: "npx" };
}

/**
 * Register one supervised Eve per launch, loopback only. The single place a
 * Bot's Eve is started: the guest's PID 1 (`init.ts`) and the local
 * `npm run up` (`eves.ts`) both come through here, so a dev gets the same
 * restart backoff, the same `/eve/v1/health` probe and the same child
 * environment as production instead of a detached process nobody watches.
 */
export function superviseEves(
  sup: Pick<Supervisor, "start"> & Partial<Pick<Supervisor, "register">>,
  launches: readonly EveLaunch[],
  opts: EveChildOptions,
): void {
  for (const launch of launches) {
    const lazy = opts.lazy?.(launch.botId) === true && sup.register !== undefined;
    const spec = {
      ...eveChildCommand(launch.cwd, launch.port, opts.exists),
      cwd: launch.cwd,
      env: eveChildEnv(launch, opts),
      gid: opts.gid,
      healthUrl: `http://127.0.0.1:${launch.port}/eve/v1/health`,
      id: `eve-${launch.botId}`,
      lazy,
      log: join(opts.logDir, `eve-${launch.botId}.log`),
      uid: opts.uid,
    };
    if (lazy) {
      sup.register?.(spec);
    } else {
      sup.start(spec);
    }
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
