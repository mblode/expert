import { ComputerError, MAX_DISPLAYS, PRIMARY_DISPLAY, type BotId, asBotId } from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import type { WindowManager } from "../desk/windows.ts";
import { ComputerService } from "./computer.ts";
import { FileService } from "./files.ts";
import { SeatService } from "./seat.ts";

/**
 * One shared box, many Bots, one screen (window index = X display) per Bot.
 * The agent token identifies the Bot; the Bot maps to its display hub-side.
 * Bots are not security boundaries: same box user, shared /workspace.
 */
export type BotConfig = {
  id: string;
  display: number;
  token: string;
};

export type Bot = {
  id: BotId;
  display: number;
  token: string;
  desk: Desk;
  seat: SeatService;
  computer: ComputerService;
  files: FileService;
  chatBusy: boolean;
};

export class BotRegistry {
  private readonly bots: Bot[] = [];

  constructor(configs: { id: string; display: number; token: string; desk: Desk }[]) {
    if (configs.length === 0) throw new Error("at least one bot is required");
    const ids = new Set<string>();
    const displays = new Set<number>();
    const tokens = new Set<string>();
    for (const c of configs) {
      if (!c.id) throw new Error("bot id is required");
      if (!c.token) throw new Error(`bot ${c.id}: token is required`);
      if (!Number.isInteger(c.display) || c.display < 1 || c.display > MAX_DISPLAYS) {
        throw new Error(`bot ${c.id}: display must be 1..${MAX_DISPLAYS}`);
      }
      if (ids.has(c.id)) throw new Error(`duplicate bot id ${c.id}`);
      if (displays.has(c.display)) throw new Error(`duplicate bot display ${c.display}`);
      if (tokens.has(c.token)) throw new Error(`duplicate bot token (${c.id})`);
      ids.add(c.id);
      displays.add(c.display);
      tokens.add(c.token);
      const seat = new SeatService();
      this.bots.push({
        id: asBotId(c.id),
        display: c.display,
        token: c.token,
        desk: c.desk,
        seat,
        computer: new ComputerService(c.desk, seat),
        files: new FileService(c.desk, seat),
        chatBusy: false,
      });
    }
  }

  all(): readonly Bot[] {
    return this.bots;
  }

  primary(): Bot {
    return this.bots.find((b) => b.display === PRIMARY_DISPLAY) ?? this.bots[0]!;
  }

  byId(id: string): Bot {
    const bot = this.bots.find((b) => b.id === id);
    if (!bot) throw new ComputerError("VALIDATION", `unknown bot ${id}`);
    return bot;
  }

  byDisplay(display: number): Bot {
    const bot = this.bots.find((b) => b.display === display);
    if (!bot) throw new ComputerError("VALIDATION", `no bot on display ${display}`);
    return bot;
  }

  hasDisplay(display: number): boolean {
    return this.bots.some((b) => b.display === display);
  }

  /** Idempotently claim each configured window on the box. */
  async ensureWindows(windows: WindowManager): Promise<void> {
    for (const bot of this.bots) {
      await windows.startWindow(bot.display, bot.token, bot.id);
    }
  }
}

/** COMPUTER_BOTS env JSON: [{"id":"main","display":1,"token":"…"}] */
export function parseBotConfigs(raw: string): BotConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("COMPUTER_BOTS must be JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("COMPUTER_BOTS must be a JSON array");
  return parsed.map((v) => {
    const o = v as Record<string, unknown>;
    return {
      id: String(o.id ?? ""),
      display: Number(o.display ?? 0),
      token: String(o.token ?? ""),
    };
  });
}
