import { randomBytes } from "node:crypto";
import { ComputerError } from "@computer/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WindowManager } from "../desk/windows.ts";
import { BotRegistry, type Bot, type BotConfig } from "./bots.ts";

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

/** JSON roster on disk. Contains bot tokens — keep it out of git and world-read. */
export class FileBotStore implements BotStore {
  constructor(private readonly path: string) {}

  /**
   * A missing roster means a fresh box. Anything else — corrupt JSON, EACCES,
   * EISDIR — must throw: a bot token is minted once and shown once, so reading
   * an unreadable roster as "no bots" would let start() mint a new primary and
   * overwrite every existing token.
   */
  load(): BotConfig[] {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(
        `bot roster ${this.path} could not be read (${(err as Error).message}). It is the only record of every bot token — fix the file or its permissions, or move it aside to start a fresh box.`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `bot roster ${this.path} is not valid JSON (${(err as Error).message}). It is the only record of every bot token — restore it from a backup, or move it aside to start a fresh box.`,
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        `bot roster ${this.path} must be a JSON array of bots, got ${parsed === null ? "null" : typeof parsed}. It is the only record of every bot token — restore it from a backup, or move it aside to start a fresh box.`,
      );
    }
    return parsed as BotConfig[];
  }

  /** Atomic: a crash mid-write leaves the previous roster (and its tokens) intact. */
  save(configs: BotConfig[]): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(this.path)}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(configs, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.path);
  }
}

export class ProvisionService {
  constructor(
    private readonly bots: BotRegistry,
    private readonly windows: WindowManager,
    private readonly store: BotStore,
  ) {}

  /** Boot: mount the roster, ensure a primary bot exists, claim every window. */
  async start(): Promise<void> {
    if (this.bots.all().length === 0) {
      this.bots.add({ id: "main", display: 1, token: mintToken() });
      this.store.save(this.bots.configs());
    }
    for (const bot of this.bots.all()) {
      try {
        await this.windows.startWindow(bot.display, bot.token, bot.id);
      } catch (err) {
        // A claim left by a roster we no longer have must not brick startup:
        // at boot the hub's roster is the source of truth, so take the window.
        if (!(err instanceof ComputerError) || err.code !== "CONFLICT") throw err;
        console.warn(`window ${bot.display}: reclaiming a stale claim for bot ${bot.id}`);
        await this.windows.startWindow(bot.display, bot.token, bot.id, true);
      }
    }
  }

  async create(id: string): Promise<Bot> {
    const bot = this.bots.add({ id, display: this.bots.allocateDisplay(), token: mintToken() });
    try {
      // allocateDisplay() only returns a display no Bot in the roster holds, and
      // the roster is authoritative — so any claim still on the box is stale.
      await this.windows.startWindow(bot.display, bot.token, bot.id, true);
    } catch (err) {
      this.bots.remove(bot.id, { allowPrimary: true });
      throw err;
    }
    this.store.save(this.bots.configs());
    return bot;
  }

  async remove(id: string): Promise<void> {
    const bot = this.bots.remove(id);
    this.store.save(this.bots.configs());
    try {
      await this.windows.stopWindow(bot.display);
    } catch (err) {
      // The roster is the source of truth: the bot is gone either way, and the
      // next create() force-reclaims the display, so a stuck window is not fatal.
      console.warn(
        `window ${bot.display}: stop failed after removing bot ${bot.id} (${(err as Error).message}); the next create() will reclaim it`,
      );
    }
  }
}

export function mintToken(): string {
  return `bot_${randomBytes(24).toString("base64url")}`;
}
