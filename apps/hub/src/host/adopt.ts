import type { BotConfig } from "../service/bots.ts";

/**
 * Bots made while the computer is running.
 *
 * The roster is read once at boot and turned into supervised children, which
 * is right for the Bots a build ships: they arrive with the image. A Bot made
 * from `Seat.CreateBot` arrives afterwards, and until something notices it, it
 * is a roster row and an agent token with no process behind it: the hub
 * forwards to it and gets `DAEMON_DOWN`, forever, with nothing in any log
 * saying why.
 *
 * So PID 1 watches the file the hub writes. The same shape as the wake
 * directory and for the same reason: the hub cannot start children (they are
 * root's, and root hands each a curated environment), so it writes state down
 * and the supervisor reads it. A poll rather than `fs.watch`, because the
 * whole state is one small file and inotify on a container filesystem is the
 * kind of thing that quietly stops delivering.
 */
interface RosterWatchOptions {
  /** The roster as it is on disk now. Throwing is expected and handled. */
  read: () => readonly BotConfig[];
  /** Bot ids already supervised, from boot. */
  seen: readonly string[];
  /** Register and wake one new Bot. Not called for ids already seen. */
  onAdopt: (bot: BotConfig) => void;
  pollMs?: number;
  onEvent?: (line: string) => void;
}

/**
 * A second is fast enough that a person who just made a Bot can talk to it,
 * and slow enough to be one small file read.
 */
const DEFAULT_POLL_MS = 1000;

/** Watch the roster and adopt Bots that were not there at boot. */
export function watchRoster(opts: RosterWatchOptions): () => void {
  const seen = new Set(opts.seen);
  const tick = (): void => {
    let roster: readonly BotConfig[];
    try {
      roster = opts.read();
    } catch (error) {
      // A half-written roster, or one the hub has not created yet. Reading it
      // again in a second is the whole recovery, and throwing out of a timer
      // in PID 1 would end the computer.
      opts.onEvent?.(`roster: unreadable (${(error as Error).message})`);
      return;
    }
    for (const bot of roster) {
      if (seen.has(bot.id)) {
        continue;
      }
      try {
        opts.onAdopt(bot);
        // Only on success: a Bot whose child could not be registered is tried
        // again next tick rather than lost until the next boot.
        seen.add(bot.id);
      } catch (error) {
        opts.onEvent?.(`roster: could not adopt ${bot.id} (${(error as Error).message})`);
      }
    }
  };
  tick();
  const timer = setInterval(tick, opts.pollMs ?? DEFAULT_POLL_MS);
  return () => clearInterval(timer);
}
