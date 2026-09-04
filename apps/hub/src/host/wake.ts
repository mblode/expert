import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Supervisor } from "./supervisor.ts";

/**
 * When a Bot is awake, written down where both halves of the guest can read it.
 *
 * A Bot's Eve is 224 MB and there are eight of them, so a Bot that nobody is
 * talking to does not run. Waking one is not something the hub can do itself:
 * the children belong to PID 1, which is root and hands each of them a
 * curated environment, and moving that into the hub would put the setup code
 * and the bridge secret one bug away from a process the model shares a uid
 * with. So the hub writes down when a Bot should be awake and the supervisor
 * reads it. One file per Bot, holding the time it may sleep again:
 *
 *   /run/computer/wake/<bot-id>   "2026-09-04T21:30:00.000Z"
 *
 * That is the whole protocol. No socket, no port, no second credential: the
 * directory is root-owned and group-writable by the hub, and the worst a
 * corrupt file can do is let a Bot sleep, which the next request undoes.
 */

/** How long a Bot stays awake after something used it. */
const DEFAULT_AWAKE_MS = 20 * 60 * 1000;

function wakeFile(dir: string, botId: string): string {
  return join(dir, botId);
}

/**
 * Keep this Bot awake until `untilMs`. Never shortens an existing window: two
 * things using one Bot must not cut each other off, so the later time wins.
 */
export function keepAwake(dir: string, botId: string, untilMs: number): void {
  mkdirSync(dir, { mode: 0o770, recursive: true });
  if (awakeUntil(dir, botId) >= untilMs) {
    return;
  }
  writeFileSync(wakeFile(dir, botId), `${new Date(untilMs).toISOString()}\n`, { mode: 0o660 });
}

/** When this Bot may sleep, or 0 for "no reason to be awake". */
export function awakeUntil(dir: string, botId: string): number {
  let raw: string;
  try {
    raw = readFileSync(wakeFile(dir, botId), "utf-8");
  } catch {
    return 0;
  }
  const at = Date.parse(raw.trim());
  return Number.isNaN(at) ? 0 : at;
}

interface SleepWatchOptions {
  /** The lazy children, by Bot id. The primary Bot is not one of them. */
  botIds: readonly string[];
  dir: string;
  sup: Pick<Supervisor, "ensure" | "stop">;
  /**
   * How often the markers are read. A poll this cheap is one small read per
   * Bot and it cannot miss an event, which `fs.watch` on a container
   * filesystem can.
   */
  pollMs?: number;
  now?: () => number;
  onEvent?: (line: string) => void;
}

/**
 * Watch the wake directory and keep the lazy Eve children matching it.
 *
 * Returns the stop function. Deliberately a poll rather than `fs.watch`: the
 * whole state is eight small files, inotify on a container filesystem is the
 * kind of thing that quietly stops delivering, and a Bot that will not wake
 * is worse than a Bot that wakes a second late.
 */
export function watchWake(opts: SleepWatchOptions): () => void {
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? 2000;
  const tick = (): void => {
    const at = now();
    for (const botId of opts.botIds) {
      if (awakeUntil(opts.dir, botId) > at) {
        opts.sup.ensure(`eve-${botId}`);
      } else {
        void opts.sup.stop(`eve-${botId}`).catch((error: unknown) => {
          opts.onEvent?.(`eve-${botId}: stop failed (${(error as Error).message})`);
        });
      }
    }
  };
  tick();
  const timer = setInterval(tick, pollMs);
  return () => clearInterval(timer);
}

interface WakerOptions {
  dir: string;
  /** How long a Bot stays awake after a request. */
  awakeMs?: number;
  /** Where that Bot's Eve listens, for the readiness probe. */
  eveUrl: (botId: string, display: number) => string;
  /** How long to wait for a woken Eve before giving up and forwarding anyway. */
  waitMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Cold start measured at about 0.7s; this is that with room for a slow boot. */
const DEFAULT_WAIT_MS = 8000;
const PROBE_EVERY_MS = 150;
/** How often an already-awake Bot's marker is rewritten. */
const TOUCH_EVERY_MS = 60_000;

/**
 * Wake a Bot and wait for it to answer, for the hub side of the protocol.
 *
 * Called before anything is forwarded to a Bot's Eve, and again by a Bot's
 * own tool calls, so a Bot working on a long turn is not put to sleep in the
 * middle of it. It resolves either way: a Bot that will not come up is a
 * `DAEMON_DOWN` from the forward that follows, which is the answer the client
 * already understands, rather than a new error from here.
 */
export function botWaker(opts: WakerOptions): (botId: string, display: number) => Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const awakeMs = opts.awakeMs ?? DEFAULT_AWAKE_MS;
  const waitMs = opts.waitMs ?? DEFAULT_WAIT_MS;
  // A Bot's own tool calls come through here, so the touch has to be cheap:
  // once a minute is enough to keep a working Bot awake, and the rest are a
  // read that decides to do nothing.
  const touched = new Map<string, number>();
  return async (botId, display) => {
    const at = now();
    const wasAwake = awakeUntil(opts.dir, botId) > at;
    if (wasAwake && at - (touched.get(botId) ?? 0) < TOUCH_EVERY_MS) {
      return;
    }
    touched.set(botId, at);
    try {
      keepAwake(opts.dir, botId, now() + awakeMs);
    } catch {
      // No wake directory (a dev box, a read-only run dir): the Bot's Eve is
      // whatever the supervisor already decided, and the forward will say so.
      return;
    }
    if (wasAwake) {
      return;
    }
    const base = opts.eveUrl(botId, display).replace(/\/$/, "");
    if (!base) {
      return;
    }
    const deadline = now() + waitMs;
    while (now() < deadline) {
      try {
        const res = await fetchImpl(`${base}/eve/v1/health`);
        if (res.ok) {
          return;
        }
      } catch {
        // Not listening yet. That is the normal case: the supervisor sees the
        // marker within its poll and the process needs about a second.
      }
      await sleep(PROBE_EVERY_MS);
    }
  };
}
