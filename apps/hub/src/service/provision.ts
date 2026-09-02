import { randomBytes } from "node:crypto";
import { ComputerError } from "@computer/shared";
import type { SeatKind } from "@computer/shared";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { WindowManager } from "../desk/windows.ts";
import type { Bot, BotConfig, BotRegistry } from "./bots.ts";

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
 * Paired seats. Same file discipline as the roster, and for the same reason:
 * these tokens are the only thing standing between a phone and the box, and
 * losing them silently unpairs every device with no way back but the setup
 * code. They were in-memory, so every hub restart did exactly that.
 */
export interface SeatRecord {
  token: string;
  kind: SeatKind;
  /** ISO time. Absent = never, which is what an owner seat gets. */
  expires_at?: string;
  /** Guests are bound to one screen; owners may pick any. */
  display?: number;
  /** Guests: full method paths they may call. Absent = SEAT_GUEST_METHODS. */
  methods?: string[];
  /** Where the token came from, for the owner's audit view. Never a secret. */
  label?: string;
  created_at: string;
}

export interface SeatTokenStore {
  load(): SeatRecord[];
  save(records: SeatRecord[]): void;
}

export class MemorySeatTokenStore implements SeatTokenStore {
  private records: SeatRecord[] = [];

  load(): SeatRecord[] {
    return this.records;
  }

  save(records: SeatRecord[]): void {
    this.records = records;
  }
}

export class FileSeatTokenStore implements SeatTokenStore {
  constructor(private readonly path: string) {}

  load(): SeatRecord[] {
    const parsed = readTokenFile(this.path, "seat tokens");
    if (parsed === undefined) {
      return [];
    }
    return parsed.map((entry) => seatRecordFrom(entry, this.path));
  }

  save(records: SeatRecord[]): void {
    writeTokenFile(this.path, records);
  }
}

/**
 * Before scopes, `seats.json` was a bare array of token strings, and those
 * files are live on both Fly volumes. A string is an owner seat that never
 * expires, exactly what it meant then, so a redeploy does not unpair anyone.
 */
function seatRecordFrom(entry: unknown, path: string): SeatRecord {
  if (typeof entry === "string") {
    return { created_at: "1970-01-01T00:00:00.000Z", kind: "owner", token: entry };
  }
  if (!entry || typeof entry !== "object") {
    throw new Error(`seat tokens ${path} must be a JSON array of strings or seat records`);
  }
  const r = entry as Partial<SeatRecord>;
  if (typeof r.token !== "string" || !r.token) {
    throw new Error(`seat tokens ${path}: a record has no token`);
  }
  if (r.kind !== "owner" && r.kind !== "guest") {
    throw new Error(`seat tokens ${path}: kind must be owner or guest`);
  }
  return {
    created_at: typeof r.created_at === "string" ? r.created_at : "1970-01-01T00:00:00.000Z",
    display: typeof r.display === "number" ? r.display : undefined,
    expires_at: typeof r.expires_at === "string" ? r.expires_at : undefined,
    kind: r.kind,
    label: typeof r.label === "string" ? r.label : undefined,
    methods: Array.isArray(r.methods) ? r.methods.filter((m) => typeof m === "string") : undefined,
    token: r.token,
  };
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
  ) {}

  /** Boot: mount the roster, ensure a primary bot exists, claim every window. */
  async start(): Promise<void> {
    if (this.bots.all().length === 0) {
      this.bots.add({ display: 1, id: "main", token: mintToken() });
      this.store.save(this.bots.configs());
    }
    for (const bot of this.bots.all()) {
      try {
        await this.windows.startWindow(bot.display, bot.token, bot.id);
      } catch (error) {
        // A claim left by a roster we no longer have must not brick startup:
        // at boot the hub's roster is the source of truth, so take the window.
        if (!(error instanceof ComputerError) || error.code !== "CONFLICT") throw error;
        console.warn(`window ${bot.display}: reclaiming a stale claim for bot ${bot.id}`);
        await this.windows.startWindow(bot.display, bot.token, bot.id, true);
      }
      await this.mountState(bot);
    }
  }

  /**
   * Bring up a Bot's directory on the box and read its transcript back, so a
   * hub restart is not an amnesia event for the human.
   *
   * Never fatal. Box state is not required to serve: a hub whose desk is not
   * answering yet must still pair, stream and hold the roster. A Bot that
   * failed to restore also does not persist for the rest of the run, see
   * VoiceService.restore, so a half-read log is never appended to.
   */
  private async mountState(bot: Bot): Promise<void> {
    try {
      await bot.state.init();
      bot.voice.restore(await bot.state.loadTranscript());
    } catch (error) {
      console.warn(`bot ${bot.id}: box state unavailable (${(error as Error).message})`);
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
    await this.mountState(bot);
    return bot;
  }

  /**
   * Free the screen and the roster entry. The Bot's directory on the box is
   * deliberately left where it is: the transcript and the memory file are a
   * human's record of what happened on their computer, and `/workspace` is
   * theirs: deleting a roster row must not silently take those with it. Grok
   * draws the same line (deleting a Bot does not remove shared-computer
   * files). Re-creating a Bot under the same name adopts what it left behind;
   * `rm -rf` from the desk is the way to actually be rid of it.
   */
  async remove(id: string): Promise<void> {
    const bot = this.bots.remove(id);
    this.store.save(this.bots.configs());
    try {
      await this.windows.stopWindow(bot.display);
    } catch (error) {
      // The roster is the source of truth: the bot is gone either way, and the
      // next create() force-reclaims the display, so a stuck window is not fatal.
      console.warn(
        `window ${bot.display}: stop failed after removing bot ${bot.id} (${(error as Error).message}); the next create() will reclaim it`,
      );
    }
  }
}

export function mintToken(): string {
  return `bot_${randomBytes(24).toString("base64url")}`;
}
