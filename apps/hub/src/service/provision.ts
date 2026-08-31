import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
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

  load(): BotConfig[] {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as BotConfig[];
    } catch {
      return [];
    }
  }

  save(configs: BotConfig[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(configs, null, 2) + "\n", { mode: 0o600 });
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
      await this.windows.startWindow(bot.display, bot.token, bot.id);
    }
  }

  async create(id: string): Promise<Bot> {
    const bot = this.bots.add({ id, display: this.bots.allocateDisplay(), token: mintToken() });
    try {
      await this.windows.startWindow(bot.display, bot.token, bot.id);
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
    await this.windows.stopWindow(bot.display);
  }
}

export function mintToken(): string {
  return `bot_${randomBytes(24).toString("base64url")}`;
}
