import { randomBytes } from "node:crypto";
import { ComputerError, PRIMARY_DISPLAY } from "@computer/shared";
import type { BotProfile } from "@computer/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WindowManager } from "../desk/windows.ts";
import type { ScreenKeeper } from "./screens.ts";
import type { Bot, BotConfig, BotRegistry } from "./bots.ts";
import type { ConversationRegistry } from "./conversations.ts";

/**
 * Computer-as-a-service: Bots are provisioned at runtime, not configured.
 * create() allocates the next free screen, mints the token, claims the
 * window on the box, and persists the roster. The token is returned once.
 */
export interface BotStore {
  load(): BotConfig[];
  save(configs: BotConfig[]): void;
}

export class MemoryBotStore implements BotStore {
  private configs: BotConfig[] = [];

  load(): BotConfig[] {
    return this.configs;
  }

  save(configs: BotConfig[]): void {
    this.configs = configs;
  }
}

/** JSON roster on disk. Contains bot tokens, keep it out of git and world-read. */
export class FileBotStore implements BotStore {
  constructor(private readonly path: string) {}

  /**
   * A missing roster means a fresh box. Anything else: corrupt JSON, EACCES,
   * EISDIR: must throw: a bot token is minted once and shown once, so reading
   * an unreadable roster as "no bots" would let start() mint a new primary and
   * overwrite every existing token.
   */
  load(): BotConfig[] {
    return (readTokenFile(this.path, "bot roster") as BotConfig[] | undefined) ?? [];
  }

  save(configs: BotConfig[]): void {
    writeTokenFile(this.path, configs);
  }
}

/**
 * A missing file is a fresh box; anything else throws. Never degrade a file
 * of tokens to "empty", that is indistinguishable from a wipe, and the
 * caller would happily write the empty state back over it.
 */
export function readTokenFile(path: string, what: string): unknown[] | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `${what} ${path} could not be read (${(error as Error).message}). It is the only record of these tokens, fix the file or its permissions, or move it aside to start fresh.`,
      { cause: error },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${what} ${path} is not valid JSON (${(error as Error).message}). It is the only record of these tokens, restore it from a backup, or move it aside to start fresh.`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(
      `${what} ${path} must be a JSON array, got ${parsed === null ? "null" : typeof parsed}. It is the only record of these tokens, restore it from a backup, or move it aside to start fresh.`,
    );
  }
  return parsed;
}

/** Atomic: a crash mid-write leaves the previous file (and its tokens) intact. */
export function writeTokenFile(path: string, value: unknown): void {
  const dir = dirname(path);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  const tmp = join(dir, `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export class ProvisionService {
  constructor(
    private readonly bots: BotRegistry,
    private readonly windows: WindowManager,
    private readonly store: BotStore,
    private readonly conversations: ConversationRegistry,
    /**
     * Who a Bot ships as, from its Eve project (`host/bot-seed.ts`). Used
     * once, when the box has no profile for that Bot yet. Absent means every
     * Bot starts under the hashed default, which is what a hub with no Eve
     * projects beside it should do.
     */
    private readonly profileSeed?: (botId: string) => Partial<BotProfile> | undefined,
    /**
     * Who claims and releases windows. Absent means the old behaviour: every
     * roster screen is claimed at boot and never released.
     */
    private readonly screens?: ScreenKeeper,
  ) {}

  /** Boot: mount the roster, ensure a primary bot exists, claim every window. */
  async start(): Promise<void> {
    if (this.bots.all().length === 0) {
      // Re-read first. The registry was built from a snapshot taken at
      // construction, and on a dev box the Eve supervisor seeds the roster
      // from the shipped projects at almost the same moment: minting `main`
      // over eight rows that appeared since would strand every token those
      // children are already holding.
      const appeared = this.store.load();
      if (appeared.length > 0) {
        for (const config of appeared) {
          this.bots.add(config);
        }
      } else {
        this.bots.add({ display: 1, id: "main", token: mintToken() });
        this.store.save(this.bots.configs());
      }
    }
    for (const bot of this.bots.all()) {
      // Only the primary screen comes up with the box. Every other Bot is
      // registered and left asleep: `ScreenKeeper` claims its window the
      // first time something touches that display and releases it again when
      // it goes quiet, because eight claimed windows is eight Chromiums and
      // this guest has 2 GB. Without a keeper (older wiring, and the tests
      // that predate it) every screen is claimed at boot as before.
      const eager = !this.screens || bot.display === PRIMARY_DISPLAY;
      if (eager) {
        try {
          await this.windows.startWindow(bot.display, bot.token, bot.id);
        } catch (error) {
          // A claim left by a roster we no longer have must not brick startup:
          // at boot the hub's roster is the source of truth, so take the window.
          if (!(error instanceof ComputerError) || error.code !== "CONFLICT") throw error;
          console.warn(`window ${bot.display}: reclaiming a stale claim for bot ${bot.id}`);
          await this.windows.startWindow(bot.display, bot.token, bot.id, true);
        }
      } else {
        // `desk-up` restores every window in the box's own assignments file
        // before the hub binds, so a Bot whose screen was up when the Machine
        // last stopped comes back with an Xvfb and a Chromium the keeper
        // would record as down and never release. Take them down here: that
        // is the whole point of a Bot that sleeps, and `stop-window` on a
        // display that is already down exits 0.
        try {
          await this.windows.stopWindow(bot.display);
        } catch (error) {
          console.warn(
            `window ${bot.display}: could not release a restored screen for bot ${bot.id} (${(error as Error).message})`,
          );
        }
      }
      this.screens?.register({ botId: bot.id, display: bot.display, token: bot.token }, eager);
      await this.mountState(bot);
    }
  }

  /**
   * Bring up a Bot's thread and its directory on the box.
   *
   * The seat conversation is resolved outside the try, and deliberately: it
   * is the hub's own file, an index that will not parse is an error rather
   * than an empty list (`readTokenFile`), and a Bot whose thread could not
   * be mounted has no voice. Everything after it is best effort. Box state is
   * not required to serve: a hub whose desk is not answering yet must still
   * pair, stream and hold the roster.
   */
  private async mountState(bot: Bot): Promise<void> {
    const seat = this.conversations.resolveSeat(bot.id);
    try {
      await bot.state.init(this.profileSeed?.(bot.id));
      await this.importTranscript(bot, seat.id);
    } catch (error) {
      console.warn(`bot ${bot.id}: box state unavailable (${(error as Error).message})`);
    }
  }

  /**
   * Seed the seat conversation from the Bot's pre-conversations
   * `transcript.jsonl`, once, so a deploy is not an amnesia event for the
   * human. `seq` is preserved, see `ConversationRegistry.importSeatLog`.
   *
   * The marker is checked before the read, so a boot after the import costs
   * nothing on the box. A transcript that could not be read is `undefined`,
   * not `[]`, and nothing is marked: the file is on a volume and it is the
   * only copy, so the import would rather run again next boot than mark
   * itself done over a box that was not answering.
   */
  private async importTranscript(bot: Bot, conversationId: string): Promise<void> {
    if (this.conversations.byId(conversationId).imported_from) {
      return;
    }
    const entries = await bot.state.readTranscript();
    if (entries === undefined) {
      return;
    }
    const written = this.conversations.importSeatLog(
      conversationId,
      bot.state.transcriptPath,
      entries,
    );
    if (written > 0) {
      console.log(
        `bot ${bot.id}: imported ${written} occurrences from ${bot.state.transcriptPath}`,
      );
    }
  }

  async create(id: string): Promise<Bot> {
    const bot = this.bots.add({ display: this.bots.allocateDisplay(), id, token: mintToken() });
    try {
      // allocateDisplay() only returns a display no Bot in the roster holds, and
      // the roster is authoritative, so any claim still on the box is stale.
      await this.windows.startWindow(bot.display, bot.token, bot.id, true);
    } catch (error) {
      this.bots.remove(bot.id, { allowPrimary: true });
      throw error;
    }
    this.store.save(this.bots.configs());
    // Claimed above, because a person is standing there: a Bot created by
    // hand should have a screen to look at without being poked first.
    this.screens?.register({ botId: bot.id, display: bot.display, token: bot.token }, true);
    await this.mountState(bot);
    return bot;
  }

  /**
   * Free the screen and the roster entry. The Bot's directory on the box and
   * its conversations are deliberately left where they are: the thread and
   * the memory file are a human's record of what happened on their computer,
   * and deleting a roster row must not silently take those with it. Grok
   * draws the same line (deleting a Bot does not remove shared-computer
   * files). Re-creating a Bot under the same name adopts what it left behind,
   * because a conversation is resolved by route and not by roster row;
   * `rm -rf` from the desk is the way to actually be rid of it.
   */
  async remove(id: string): Promise<void> {
    const bot = this.bots.remove(id);
    this.store.save(this.bots.configs());
    try {
      // Stop the window before forgetting the screen, not after: a claim in
      // flight from a concurrent action would otherwise finish after the stop
      // and leave a window up that no keeper entry covers.
      await this.windows.stopWindow(bot.display);
    } catch (error) {
      // The roster is the source of truth: the bot is gone either way, and the
      // next create() force-reclaims the display, so a stuck window is not fatal.
      console.warn(
        `window ${bot.display}: stop failed after removing bot ${bot.id} (${(error as Error).message}); the next create() will reclaim it`,
      );
    }
    this.screens?.forget(bot.display);
  }
}

export function mintToken(): string {
  return `bot_${randomBytes(24).toString("base64url")}`;
}
