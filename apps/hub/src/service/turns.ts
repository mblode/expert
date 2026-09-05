import { randomBytes } from "node:crypto";
import { ComputerError } from "@computer/shared";
import { readTokenFile, writeTokenFile } from "./provision.ts";

/**
 * Turn tokens: how the hub knows which conversation a `send_message` belongs
 * to without the model being able to say.
 *
 * The connector ingress mints one, bound to the conversation it just resolved
 * and to the Bot it is about to call, and forwards it as `x-computer-turn`.
 * Eve puts it on the session's auth attributes, which tool code reads and a
 * prompt cannot change, and the `send_message` tool hands it back on the same
 * header. Nothing in the model's context ever holds it, and nothing the model
 * can call mints one, so a conversation id is never a thing the model names.
 *
 * The token is also the natural home for the hop budget and the deadline, so
 * the bot-to-bot guards will need no second mechanism. Nothing decrements
 * `hops_left` today: there is one Bot per deployment and no peer route.
 */
interface Turn {
  id: string;
  conversation_id: string;
  /** The Bot this turn was minted for. Another Bot presenting it is refused. */
  bot: string;
  /** Peer hops still allowed. Minted full, decremented when peers land. */
  hops_left: number;
  owner?: { acct: string; jid: string };
  deadline_at: number;
}

/**
 * How long a minted turn stays good.
 *
 * The ceiling is what the caller can wait for anyway: Eve's own hub client
 * gives up at 150 s (`apps/eve/lib/hub.ts`), so a token that outlived that
 * could only be replayed, never used. Short enough that a leaked header is
 * not a standing capability, long enough that a slow turn's last send still
 * lands.
 */
const TURN_TTL_MS = 150_000;

/** Peer hops a human turn is allowed to spend. Phase 3 spends them. */
const MAX_HOPS = 3;

export class TurnService {
  private readonly turns = new Map<string, Turn>();

  /** `ttlMs` is injectable so tests do not wait out the real window. */
  constructor(
    private readonly ttlMs: number = TURN_TTL_MS,
    private readonly path?: string,
  ) {
    for (const row of path ? (readTokenFile(path, "turns") ?? []) : []) {
      const turn = row as Turn;
      if (
        !turn ||
        typeof turn.id !== "string" ||
        !/^turn_[A-Za-z0-9_-]+$/.test(turn.id) ||
        typeof turn.bot !== "string" ||
        typeof turn.conversation_id !== "string" ||
        !Number.isFinite(turn.deadline_at) ||
        !Number.isInteger(turn.hops_left) ||
        (turn.owner !== undefined &&
          (!turn.owner ||
            typeof turn.owner.acct !== "string" ||
            typeof turn.owner.jid !== "string"))
      ) {
        throw new Error("invalid turn store");
      }
      if (turn.deadline_at > Date.now()) this.turns.set(turn.id, turn);
    }
  }

  private save(): void {
    if (this.path) writeTokenFile(this.path, [...this.turns.values()]);
  }

  mint(opts: {
    conversation_id: string;
    bot: string;
    hops_left?: number;
    owner?: Turn["owner"];
  }): Turn {
    // No timer: an expired turn is swept the next time one is minted, and
    // refused on sight either way. A pending sweep is not a reason to keep
    // the hub alive, and the map only grows at the rate of inbound messages.
    this.expire();
    const turn: Turn = {
      bot: opts.bot,
      ...(opts.owner ? { owner: opts.owner } : {}),
      conversation_id: opts.conversation_id,
      deadline_at: Date.now() + this.ttlMs,
      hops_left: opts.hops_left ?? MAX_HOPS,
      id: `turn_${randomBytes(18).toString("base64url")}`,
    };
    this.turns.set(turn.id, turn);
    this.save();
    return turn;
  }

  /**
   * Three separate refusals, deliberately.
   *
   * A token this hub did not mint and one whose deadline has passed are both
   * `UNAUTHENTICATED`: the credential is not good, and the caller learns
   * nothing about which of the two it was. A real token presented by the
   * wrong Bot is `DENIED`, because that is not a bad credential, it is a Bot
   * reaching for another Bot's conversation, and the answer is the same 403
   * the peer allowlist will give.
   */
  verify(token: string, bot: string): Turn {
    const turn = this.turns.get(token);
    if (!turn) {
      throw new ComputerError("UNAUTHENTICATED", "unknown turn");
    }
    if (turn.deadline_at <= Date.now()) {
      this.turns.delete(token);
      this.save();
      throw new ComputerError("UNAUTHENTICATED", "this turn has expired");
    }
    if (turn.bot !== bot) {
      throw new ComputerError("DENIED", `this turn belongs to bot ${turn.bot}`);
    }
    return turn;
  }

  /** Only the trusted request driver may keep a live execution authorized. */
  keepAlive(token: string, bot: string): () => void {
    this.verify(token, bot);
    const timer = setInterval(
      () => {
        try {
          const turn = this.verify(token, bot);
          turn.deadline_at = Date.now() + this.ttlMs;
          this.save();
        } catch {
          clearInterval(timer);
        }
      },
      Math.max(1, Math.floor(this.ttlMs / 3)),
    );
    timer.unref();
    return () => clearInterval(timer);
  }

  /** Drop everything past its deadline. */
  expire(now: number = Date.now()): void {
    let changed = false;
    for (const [id, turn] of this.turns) {
      if (turn.deadline_at <= now) {
        this.turns.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }
}
