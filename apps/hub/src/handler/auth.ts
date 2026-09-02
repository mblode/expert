import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError, SEAT_GUEST_METHODS } from "@computer/shared";
import type { AuthPolicy } from "@computer/proto";
import { MemorySeatTokenStore } from "../service/provision.ts";
import type { SeatRecord, SeatTokenStore } from "../service/provision.ts";
import { PixelRegistry } from "../service/pixels.ts";

type TokenKind = "agent" | "seat";

export interface Verified {
  kind: TokenKind | "public";
  botId?: string;
  /** Set for seat calls: what this token may do. Handlers bind guests to their display. */
  seat?: SeatRecord;
}

const PAIR_MAX_FAILURES = 10;
const PAIR_LOCKOUT_MS = 60_000;

/** The longest a guest seat may live. An invite asks for less; it never gets more. */
export const GUEST_MAX_TTL_MS = 15 * 60_000;

export class AuthRegistry {
  private readonly setupCode: string;
  private readonly pairFailures = { blockedUntil: 0, count: 0 };
  /** Live view of the roster: [token, botId] pairs. Provisioning needs no auth sync. */
  private readonly agentTokens: () => Iterable<[string, string]>;
  private readonly seats: SeatTokenStore;
  private readonly seatRecords: Map<string, SeatRecord>;
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
      throw new Error("COMPUTER_SETUP_CODE is required, run `npm run up` to generate one");
    }
    if (typeof opts.agentTokens !== "function") {
      throw new TypeError(
        "agentTokens must be a function returning the roster's [token, botId] pairs",
      );
    }
    this.setupCode = opts.setupCode;
    this.agentTokens = opts.agentTokens;
    this.seats = opts.seats ?? new MemorySeatTokenStore();
    this.seatRecords = new Map(this.seats.load().map((r) => [r.token, r]));
    this.pixels = opts.pixels ?? new PixelRegistry();
  }

  /**
   * Pair is the one unauthenticated write. Ten wrong codes lock it for a
   * minute, so a setup code cannot be guessed online at network speed.
   */
  pair(code: string, now = Date.now()): string {
    if (this.pairFailures.blockedUntil > now) {
      throw new ComputerError("UNAUTHENTICATED", "too many bad setup codes, try again later");
    }
    if (!safeEqual(code, this.setupCode)) {
      this.pairFailures.count += 1;
      if (this.pairFailures.count >= PAIR_MAX_FAILURES) {
        this.pairFailures.count = 0;
        this.pairFailures.blockedUntil = now + PAIR_LOCKOUT_MS;
      }
      throw new ComputerError("UNAUTHENTICATED", "bad setup code");
    }
    this.pairFailures.count = 0;
    return this.mint({ created_at: new Date(now).toISOString(), kind: "owner" }).token;
  }

  /**
   * `method` is the RPC path being called. A guest seat carries its own
   * allowlist, checked here so a handler cannot forget; owners keep the
   * whole Seat service as before.
   */
  verify(policy: AuthPolicy, bearer: string | undefined, method?: string): Verified {
    if (policy === "public" || policy === "pair") {
      return { kind: "public" };
    }
    if (!bearer) {
      throw new ComputerError("UNAUTHENTICATED", "missing bearer");
    }
    if (policy === "agent") {
      // Constant-time compare against every entry; no early exit on match.
      let botId: string | undefined;
      for (const [token, id] of this.agentTokens()) {
        if (safeEqual(bearer, token)) {
          botId = id;
        }
      }
      if (botId === undefined) {
        throw new ComputerError(
          "UNAUTHENTICATED",
          "bad bearer, a bot token comes from CreateBot or `npm run bot -- token <id>`",
        );
      }
      return { botId, kind: "agent" };
    }
    if (policy === "seat") {
      const seat = this.seatFor(bearer);
      if (!seat) {
        throw new ComputerError("UNAUTHENTICATED", "seat token required");
      }
      if (seat.kind === "guest" && method && !guestMethods(seat).includes(method)) {
        throw new ComputerError("UNAUTHENTICATED", "this seat cannot do that");
      }
      return { kind: "seat", seat };
    }
    throw new ComputerError("UNAUTHENTICATED", "unknown policy");
  }

  /** The record behind a live token, or nothing for an unknown, expired or revoked one. */
  seatFor(token: string | undefined, now = Date.now()): SeatRecord | undefined {
    if (typeof token !== "string" || token.length === 0) {
      return undefined;
    }
    const record = this.seatRecords.get(token);
    if (!record) {
      return undefined;
    }
    if (record.expires_at && Date.parse(record.expires_at) <= now) {
      // Expiry is enforced on read so a stopped sweep cannot extend a guest.
      this.seatRecords.delete(token);
      this.persist();
      return undefined;
    }
    return record;
  }

  hasSeatToken(token: string | undefined): boolean {
    return this.seatFor(token) !== undefined;
  }

  /** Owner seats only: the thread, provisioning, and the Eve proxy are theirs. */
  isOwner(token: string | undefined): boolean {
    return this.seatFor(token)?.kind === "owner";
  }

  /** Owner seat or a live pixel grant. A guest reaches /vnc through the grant its Status returned. */
  canViewPixels(token: string | undefined): boolean {
    return this.isOwner(token) || this.pixels.lookup(token) !== undefined;
  }

  /**
   * A guest seat for one display, expiring. Minted by an invite (Phase 2),
   * never by Pair. `methods` may only narrow the guest default, never widen it.
   */
  mintGuest(
    opts: { display: number; ttlMs: number; methods?: string[]; label?: string },
    now = Date.now(),
  ): SeatRecord {
    if (!Number.isInteger(opts.display) || opts.display < 1) {
      throw new ComputerError("VALIDATION", "guest seat needs a display");
    }
    if (!Number.isFinite(opts.ttlMs) || opts.ttlMs <= 0) {
      throw new ComputerError("VALIDATION", "guest seat needs a positive ttl");
    }
    const ttl = Math.min(opts.ttlMs, GUEST_MAX_TTL_MS);
    const methods = (opts.methods ?? [...SEAT_GUEST_METHODS]).filter((m) =>
      (SEAT_GUEST_METHODS as readonly string[]).includes(m),
    );
    return this.mint({
      created_at: new Date(now).toISOString(),
      display: opts.display,
      expires_at: new Date(now + ttl).toISOString(),
      kind: "guest",
      label: opts.label,
      methods,
    });
  }

  /** Drop a token. Idempotent: revoking twice, or an unknown token, is not an error. */
  revoke(token: string): boolean {
    const had = this.seatRecords.delete(token);
    if (had) {
      this.persist();
    }
    return had;
  }

  /** Drop every expired guest. Reads already do this lazily; the sweep keeps the file small. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [token, record] of this.seatRecords) {
      if (record.expires_at && Date.parse(record.expires_at) <= now) {
        this.seatRecords.delete(token);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.persist();
    }
    return dropped;
  }

  /** Every live seat, tokens included: for the owner's own audit and revoke UI, never a public route. */
  listSeats(now = Date.now()): SeatRecord[] {
    this.sweep(now);
    return [...this.seatRecords.values()];
  }

  /**
   * Persist before returning. A token handed to a phone that never reached
   * disk is worse than a failed pairing: the phone believes it is paired and
   * the next restart says otherwise, which is the bug this store exists for.
   */
  private mint(record: Omit<SeatRecord, "token">): SeatRecord {
    const full: SeatRecord = { ...record, token: randomBytes(24).toString("base64url") };
    this.seatRecords.set(full.token, full);
    this.persist();
    return full;
  }

  private persist(): void {
    this.seats.save([...this.seatRecords.values()]);
  }
}

function guestMethods(seat: SeatRecord): readonly string[] {
  return seat.methods ?? SEAT_GUEST_METHODS;
}

export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const m = /^Bearer\s+(\S+)/i.exec(header);
  return m?.[1];
}

/** Seat token from Authorization or `?token=` (WKWebView / noVNC cannot set headers on WS). */
export function tokenFromRequest(req: {
  url?: string;
  headers: { authorization?: string | string[] };
}): string | undefined {
  const auth = Array.isArray(req.headers.authorization)
    ? req.headers.authorization[0]
    : req.headers.authorization;
  const fromHeader = bearerFromHeader(auth);
  if (fromHeader) {
    return fromHeader;
  }
  try {
    return new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}
