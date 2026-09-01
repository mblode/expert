import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError } from "@computer/shared";
import type { AuthPolicy } from "@computer/proto";
import { MemorySeatTokenStore, type SeatTokenStore } from "../service/provision.ts";
import { PixelRegistry } from "../service/pixels.ts";

export type TokenKind = "agent" | "seat";

export type Verified = { kind: TokenKind | "public"; botId?: string };

export class AuthRegistry {
  private readonly setupCode: string;
  /** Live view of the roster: [token, botId] pairs. Provisioning needs no auth sync. */
  private readonly agentTokens: () => Iterable<[string, string]>;
  private readonly seats: SeatTokenStore;
  private readonly seatTokens: Set<string>;
  readonly pixels: PixelRegistry;

  constructor(opts: {
    setupCode: string;
    agentTokens: () => Iterable<[string, string]>;
    /** Survives a restart. Memory only where nobody is meant to stay paired. */
    seats?: SeatTokenStore;
    /** Short-lived noVNC tokens. Absent = mint against a memory registry. */
    pixels?: PixelRegistry;
  }) {
    if (!opts.setupCode) {
      throw new Error("COMPUTER_SETUP_CODE is required — run `npm run up` to generate one");
    }
    if (typeof opts.agentTokens !== "function") {
      throw new Error("agentTokens must be a function returning the roster's [token, botId] pairs");
    }
    this.setupCode = opts.setupCode;
    this.agentTokens = opts.agentTokens;
    this.seats = opts.seats ?? new MemorySeatTokenStore();
    this.seatTokens = new Set(this.seats.load());
    this.pixels = opts.pixels ?? new PixelRegistry();
  }

  pair(code: string): string {
    if (!safeEqual(code, this.setupCode)) {
      throw new ComputerError("UNAUTHENTICATED", "bad setup code");
    }
    return this.mint();
  }

  verify(policy: AuthPolicy, bearer: string | undefined): Verified {
    if (policy === "public" || policy === "pair") return { kind: "public" };
    if (!bearer) throw new ComputerError("UNAUTHENTICATED", "missing bearer");
    if (policy === "agent") {
      // Constant-time compare against every entry; no early exit on match.
      let botId: string | undefined;
      for (const [token, id] of this.agentTokens()) {
        if (safeEqual(bearer, token)) botId = id;
      }
      if (botId === undefined) {
        throw new ComputerError("UNAUTHENTICATED", "bad bearer — a bot token comes from CreateBot or `npm run bot -- token <id>`");
      }
      return { kind: "agent", botId };
    }
    if (policy === "seat") {
      if (!this.seatTokens.has(bearer)) {
        throw new ComputerError("UNAUTHENTICATED", "seat token required");
      }
      return { kind: "seat" };
    }
    throw new ComputerError("UNAUTHENTICATED", "unknown policy");
  }

  hasSeatToken(token: string | undefined): boolean {
    return typeof token === "string" && token.length > 0 && this.seatTokens.has(token);
  }

  /** Seat token (pairing) or a live pixel grant. Either may open /vnc. */
  canViewPixels(token: string | undefined): boolean {
    return this.hasSeatToken(token) || this.pixels.lookup(token) !== undefined;
  }

  /** Test helper */
  issueSeatToken(): string {
    return this.mint();
  }

  /**
   * Persist before returning. A token handed to a phone that never reached
   * disk is worse than a failed pairing: the phone believes it is paired and
   * the next restart says otherwise, which is the bug this store exists for.
   */
  private mint(): string {
    const token = randomBytes(24).toString("base64url");
    this.seatTokens.add(token);
    this.seats.save([...this.seatTokens]);
    return token;
  }
}

export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(\S+)/i.exec(header);
  return m?.[1];
}

/** Seat token from Authorization or `?token=` (WKWebView / noVNC cannot set headers on WS). */
export function tokenFromRequest(req: { url?: string; headers: { authorization?: string | string[] } }): string | undefined {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const fromHeader = bearerFromHeader(auth);
  if (fromHeader) return fromHeader;
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

export function withSeatToken(base: string, token: string): string {
  try {
    const u = new URL(base);
    u.searchParams.set("view_only", "1");
    u.searchParams.set("token", token);
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}view_only=1&token=${encodeURIComponent(token)}`;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
