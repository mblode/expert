import {
  ComputerError,
  MAX_DISPLAYS,
  PRIMARY_DISPLAY,
  asBotId,
  unavailable,
  type BotId,
} from "@computer/shared";
import type { Desk } from "../desk/types.ts";
import { ComputerService } from "./computer.ts";
import { FileService } from "./files.ts";
import { PolicyService } from "./policy.ts";
import { SeatService } from "./seat.ts";
import { BotState } from "./state.ts";
import { VoiceService } from "./voice.ts";

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
  /** This Bot's directory on the box: profile, memory, transcript. Never its token. */
  state: BotState;
  voice: VoiceService;
  computer: ComputerService;
  files: FileService;
};

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class BotRegistry {
  private readonly bots: Bot[] = [];

  /** Policy is box-wide, not per-Bot: Bots are not security boundaries. */
  constructor(
    private readonly deskFactory: (display: number) => Desk,
    configs: BotConfig[] = [],
    private readonly policy: PolicyService = new PolicyService(),
  ) {
    for (const c of configs) this.add(c);
  }

  /** Validate and mount a Bot. Throws ComputerError so RPC callers get clean envelopes. */
  add(c: BotConfig): Bot {
    if (!ID_RE.test(c.id)) {
      throw new ComputerError("VALIDATION", "bot id must be 1-32 chars of a-z 0-9 - (start alphanumeric)");
    }
    if (!c.token) throw new ComputerError("VALIDATION", `bot ${c.id}: token is required`);
    if (!Number.isInteger(c.display) || c.display < 1 || c.display > MAX_DISPLAYS) {
      throw new ComputerError("VALIDATION", `bot ${c.id}: display must be 1..${MAX_DISPLAYS}`);
    }
    if (this.bots.some((b) => b.id === c.id)) {
      throw new ComputerError("CONFLICT", `bot ${c.id} already exists`);
    }
    if (this.bots.some((b) => b.display === c.display)) {
      throw new ComputerError("CONFLICT", `display ${c.display} is taken`);
    }
    if (this.bots.some((b) => b.token === c.token)) {
      throw new ComputerError("CONFLICT", `token already in use (${c.id})`);
    }
    const desk = this.deskFactory(c.display);
    const seat = new SeatService();
    const state = new BotState(desk, c.id);
    const bot: Bot = {
      id: asBotId(c.id),
      display: c.display,
      token: c.token,
      desk,
      seat,
      state,
      // The Bot's directory is where the occurrence log stops being a
      // process-lifetime thing; ProvisionService reads it back at boot.
      voice: new VoiceService(desk, undefined, state),
      computer: new ComputerService(desk, seat, this.policy),
      files: new FileService(desk, seat, this.policy),
    };
    this.bots.push(bot);
    return bot;
  }

  remove(id: string, opts: { allowPrimary?: boolean } = {}): Bot {
    const i = this.bots.findIndex((b) => b.id === id);
    if (i < 0) throw new ComputerError("VALIDATION", `unknown bot ${id}`);
    if (!opts.allowPrimary && this.bots[i]!.display === PRIMARY_DISPLAY) {
      throw new ComputerError("VALIDATION", "the primary bot cannot be deleted");
    }
    return this.bots.splice(i, 1)[0]!;
  }

  /** Lowest free window index, or CONFLICT when all screens are in use. */
  allocateDisplay(): number {
    for (let d = 1; d <= MAX_DISPLAYS; d++) {
      if (!this.bots.some((b) => b.display === d)) return d;
    }
    throw new ComputerError("CONFLICT", `all ${MAX_DISPLAYS} screens are in use — delete a bot first`);
  }

  all(): readonly Bot[] {
    return this.bots;
  }

  configs(): BotConfig[] {
    return this.bots.map((b) => ({ id: b.id as string, display: b.display, token: b.token }));
  }

  tokenEntries(): [token: string, botId: string][] {
    return this.bots.map((b) => [b.token, b.id as string]);
  }

  primary(): Bot {
    const bot = this.bots.find((b) => b.display === PRIMARY_DISPLAY) ?? this.bots[0];
    // Nothing to attach to and nothing a retry can fix — the roster has to change.
    if (!bot) {
      throw new ComputerError(
        "DAEMON_DOWN",
        "no bots mounted",
        unavailable("not_bound", "route_missing"),
      );
    }
    return bot;
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
}
