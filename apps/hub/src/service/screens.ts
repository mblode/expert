import { PRIMARY_DISPLAY } from "@computer/shared";
import type { WindowManager } from "../desk/windows.ts";

/**
 * Screens are claimed when they are used and released when they are not.
 *
 * A claimed window is an Xvfb, an openbox, an x11vnc and a Chromium, about
 * 430 MB measured, and this box has 2 GB for a roster of eight. Claiming all
 * of them at boot spends the whole machine on desktops nobody is looking at,
 * so a Bot with nothing to do owns no screen at all: the first thing that
 * touches its display brings the window up (`desk/lazy.ts` wraps every X
 * method), and `sweep()` takes it down again after `idleMs` of nothing.
 *
 * The primary screen is never released. It is the desk the box boots with,
 * `desk-up` claims it before the hub binds, and a computer whose one screen
 * comes and goes is a computer that looks broken.
 *
 * Claiming is idempotent and forced: the roster is the authority on which Bot
 * owns which display, so a claim left behind by an earlier boot is taken
 * rather than argued with. That is the same rule `ProvisionService.start`
 * already applies to a stale claim.
 */
interface ScreenClaim {
  display: number;
  /** The Bot's token, hashed into the owner mark on the box. Never stored. */
  token: string;
  botId: string;
}

interface ScreenState extends ScreenClaim {
  /** Up on the box as far as this hub knows. */
  up: boolean;
  lastUsed: number;
  /** One claim at a time: a burst of actions must not race start-window. */
  claiming: Promise<void> | null;
  /**
   * A `stop-window` in flight. `up` is cleared before it starts, so a request
   * that arrives mid-teardown queues behind it and re-claims rather than
   * reading a dying X server as a live screen.
   */
  releasing: Promise<void> | null;
}

interface ScreenKeeperOptions {
  /** How long a screen may go unused before it is released. */
  idleMs?: number;
  /** How many screens may be up at once, the primary one included. */
  maxUp?: number;
  /** A screen a human is at, or one waiting for one, is never released. */
  isBusy?: (display: number) => boolean;
  now?: () => number;
  onEvent?: (line: string) => void;
}

/** Half an hour: long enough to read a page, short enough to matter. */
const DEFAULT_IDLE_MS = 30 * 60 * 1000;

/**
 * How many windows may be claimed at once, the primary one included. A window
 * is about 430 MB, so two is what a 2 GB guest has room for beside the hub and
 * a couple of Eves. Idling out at half an hour is not enough on its own: a
 * person clicking through eight Bots claims eight windows inside a minute.
 */
const DEFAULT_MAX_UP = 2;

export class ScreenKeeper {
  private readonly screens = new Map<number, ScreenState>();
  private readonly idleMs: number;
  private readonly maxUp: number;
  private readonly now: () => number;
  private readonly isBusy: (display: number) => boolean;
  private readonly onEvent: ((line: string) => void) | undefined;

  constructor(
    private readonly windows: WindowManager,
    opts: ScreenKeeperOptions = {},
  ) {
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.maxUp = opts.maxUp ?? DEFAULT_MAX_UP;
    this.now = opts.now ?? Date.now;
    this.isBusy = opts.isBusy ?? (() => false);
    this.onEvent = opts.onEvent;
  }

  /** Mount a Bot's screen. `up` says whether the window is already claimed. */
  register(claim: ScreenClaim, up = false): void {
    this.screens.set(claim.display, {
      ...claim,
      claiming: null,
      lastUsed: this.now(),
      releasing: null,
      up,
    });
  }

  forget(display: number): void {
    this.screens.delete(display);
  }

  isUp(display: number): boolean {
    return this.screens.get(display)?.up ?? false;
  }

  /**
   * Something is about to touch this screen. Brings the window up if it is
   * down, and records the use either way.
   *
   * A display nobody registered is left alone rather than claimed: the hub
   * would not know whose it is, and a desk call against a dead display
   * already fails as `DAEMON_DOWN`, which is the honest answer.
   */
  async use(display: number): Promise<void> {
    const screen = this.screens.get(display);
    if (!screen) {
      return;
    }
    screen.lastUsed = this.now();
    // A release in flight has already cleared `up`; wait for it rather than
    // claiming into a window that is still being torn down.
    if (screen.releasing) {
      await screen.releasing.catch(() => undefined);
    }
    if (screen.up) {
      return;
    }
    await this.makeRoom(screen.display);
    // Concurrent actions on a sleeping screen share one start-window.
    screen.claiming ??= this.claim(screen);
    try {
      await screen.claiming;
    } finally {
      screen.claiming = null;
    }
  }

  /**
   * Release the least recently used screen until this one fits.
   *
   * Idling out is not enough by itself: a person opening eight Bots in a
   * minute would claim eight windows, which is more memory than the guest
   * has, and the OOM killer picks the victim rather than this. The primary
   * screen, a screen a human is at, and one mid-claim are never the victim,
   * so the worst case is that the cap cannot be met and the claim goes ahead:
   * a slow box beats refusing to show a Bot its own screen.
   */
  private async makeRoom(forDisplay: number): Promise<void> {
    for (;;) {
      const up = [...this.screens.values()].filter((s) => s.up);
      if (up.length < this.maxUp) {
        return;
      }
      const [victim] = up
        .filter(
          (s) =>
            s.display !== PRIMARY_DISPLAY &&
            s.display !== forDisplay &&
            !s.claiming &&
            !this.isBusy(s.display),
        )
        .toSorted((a, b) => a.lastUsed - b.lastUsed);
      if (!victim) {
        return;
      }
      try {
        await this.release(victim);
      } catch (error) {
        this.onEvent?.(
          `screen ${victim.display}: stop failed (${(error as Error).message}); claiming anyway`,
        );
        return;
      }
      this.onEvent?.(`screen ${victim.display} released to make room (bot ${victim.botId})`);
    }
  }

  /** Release what has gone quiet. Called on a timer; never throws. */
  async sweep(): Promise<void> {
    const cutoff = this.now() - this.idleMs;
    for (const screen of this.screens.values()) {
      if (
        !screen.up ||
        screen.display === PRIMARY_DISPLAY ||
        screen.claiming ||
        screen.releasing ||
        screen.lastUsed > cutoff ||
        this.isBusy(screen.display)
      ) {
        continue;
      }
      try {
        await this.release(screen);
        this.onEvent?.(`screen ${screen.display} released after idle (bot ${screen.botId})`);
      } catch (error) {
        // A screen that will not stop is memory we wanted back, not an
        // outage: it is marked up again and the next sweep tries again.
        this.onEvent?.(
          `screen ${screen.display}: stop failed (${(error as Error).message}); still up`,
        );
      }
    }
  }

  /**
   * Take a window down. `up` is cleared first and the promise is published on
   * the state, so anything that arrives while `stop-window` runs waits and
   * then claims a fresh one instead of driving the screen being killed.
   */
  private async release(screen: ScreenState): Promise<void> {
    screen.up = false;
    const releasing = this.windows.stopWindow(screen.display);
    screen.releasing = releasing.then(
      () => undefined,
      () => undefined,
    );
    try {
      await releasing;
    } catch (error) {
      screen.up = true;
      throw error;
    } finally {
      screen.releasing = null;
    }
  }

  private async claim(screen: ScreenState): Promise<void> {
    await this.windows.startWindow(screen.display, screen.token, screen.botId, true);
    screen.up = true;
    screen.lastUsed = this.now();
    this.onEvent?.(`screen ${screen.display} claimed on demand (bot ${screen.botId})`);
  }
}
