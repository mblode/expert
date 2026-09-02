import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ComputerError,
  PRIVILEGED_ROLES,
  SEAT_GUEST_METHODS,
  principalAllows,
} from "@computer/shared";
import type { Role } from "@computer/shared";
import type { AuthPolicy } from "@computer/proto";
import { MemoryPrincipalStore } from "../service/principals.ts";
import type { PrincipalRecord, PrincipalStore } from "../service/principals.ts";
import { PixelRegistry } from "../service/pixels.ts";

/**
 * One verify path for every door.
 *
 * A seat token, a bot token and a channel secret used to be three unrelated
 * checks; they now resolve to one `PrincipalRecord`, so a handler asks what
 * this caller may do rather than which file its credential came from. Bots
 * are still stored with their display in the roster and adapted here, which
 * keeps this change about identity rather than about storage.
 */
export interface Verified {
  kind: "agent" | "seat" | "public";
  /** Set for agent calls: the Bot the bearer belongs to. */
  botId?: string;
  /** Set for anything authenticated. Handlers bind a bound principal to its display. */
  principal?: PrincipalRecord;
}

const PAIR_MAX_FAILURES = 10;
const PAIR_LOCKOUT_MS = 60_000;

/** The longest a guest seat may live. An invite asks for less; it never gets more. */
export const GUEST_MAX_TTL_MS = 15 * 60_000;

/** The longest anything issued for a person may live. Owners paired at the box are exempt. */
export const ISSUED_MAX_TTL_MS = 30 * 24 * 60 * 60_000;

export class AuthRegistry {
  private readonly setupCode: string;
  private readonly pairFailures = { blockedUntil: 0, count: 0 };
  /** Live view of the roster: [token, botId] pairs. Provisioning needs no auth sync. */
  private readonly agentTokens: () => Iterable<[string, string]>;
  private readonly store: PrincipalStore;
  private readonly records: Map<string, PrincipalRecord>;
  readonly pixels: PixelRegistry;

  constructor(opts: {
    setupCode: string;
    agentTokens: () => Iterable<[string, string]>;
    /** Survives a restart. Memory only where nobody is meant to stay paired. */
    principals?: PrincipalStore;
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
    this.store = opts.principals ?? new MemoryPrincipalStore();
    this.records = new Map(this.store.load().map((r) => [r.token, r]));
    this.pixels = opts.pixels ?? new PixelRegistry();
  }

  /**
   * Pair is the one unauthenticated write. Ten wrong codes lock it for a
   * minute, so a setup code cannot be guessed online at network speed.
   *
   * It still mints an owner with no subject: whoever holds the code is the
   * box's owner and the hub has no way to learn their name. A control plane
   * that knows its users pairs once, keeps an `issuer`, and calls `Issue`
   * with a subject from then on.
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
    return this.mint({ created_at: new Date(now).toISOString(), kind: "user", role: "owner" })
      .token;
  }

  /**
   * `method` is the RPC path being called, checked here so a handler cannot
   * forget. An owner is unrestricted inside the Seat service, as a paired
   * seat has always been; every narrower role carries an allowlist.
   */
  verify(policy: AuthPolicy, bearer: string | undefined, method?: string): Verified {
    if (policy === "public" || policy === "pair") {
      return { kind: "public" };
    }
    if (!bearer) {
      throw new ComputerError("UNAUTHENTICATED", "missing bearer");
    }
    if (policy === "agent") {
      const botId = this.botFor(bearer);
      if (botId === undefined) {
        throw new ComputerError(
          "UNAUTHENTICATED",
          "bad bearer, a bot token comes from CreateBot or `npm run bot -- token <id>`",
        );
      }
      return { botId, kind: "agent", principal: botPrincipal(bearer, botId) };
    }
    if (policy === "seat") {
      const principal = this.principalFor(bearer);
      if (!principal) {
        throw new ComputerError("UNAUTHENTICATED", "seat token required");
      }
      if (!principalAllows(principal.role, principal.methods, method)) {
        throw new ComputerError("UNAUTHENTICATED", "this seat cannot do that");
      }
      return { kind: "seat", principal };
    }
    throw new ComputerError("UNAUTHENTICATED", "unknown policy");
  }

  /** The Bot behind an agent token, in constant time across the whole roster. */
  private botFor(bearer: string): string | undefined {
    // Compare against every entry; no early exit on match.
    let botId: string | undefined;
    for (const [token, id] of this.agentTokens()) {
      if (safeEqual(bearer, token)) {
        botId = id;
      }
    }
    return botId;
  }

  /** The record behind a live token, or nothing for an unknown, expired or revoked one. */
  principalFor(token: string | undefined, now = Date.now()): PrincipalRecord | undefined {
    if (typeof token !== "string" || token.length === 0) {
      return undefined;
    }
    const record = this.records.get(token);
    if (!record) {
      return undefined;
    }
    if (record.expires_at && Date.parse(record.expires_at) <= now) {
      // Expiry is enforced on read so a stopped sweep cannot extend a grant.
      this.records.delete(token);
      this.persist();
      return undefined;
    }
    return record;
  }

  hasSeatToken(token: string | undefined): boolean {
    return this.principalFor(token) !== undefined;
  }

  roleOf(token: string | undefined): Role | undefined {
    return this.principalFor(token)?.role;
  }

  /** Owner seats only: the thread, provisioning, and the Eve proxy are theirs. */
  isOwner(token: string | undefined): boolean {
    return this.roleOf(token) === "owner";
  }

  /** Owner seat or a live pixel grant. A narrower seat reaches /vnc through the grant its Status returned. */
  canViewPixels(token: string | undefined): boolean {
    return this.isOwner(token) || this.pixels.lookup(token) !== undefined;
  }

  /**
   * A guest seat for one display, expiring. Minted by an invite, never by
   * `Pair`. `methods` may only narrow the guest default, never widen it.
   */
  mintGuest(
    opts: { display: number; ttlMs: number; methods?: string[]; label?: string },
    now = Date.now(),
  ): PrincipalRecord {
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
      kind: "user",
      label: opts.label,
      methods,
      role: "guest",
    });
  }

  /**
   * Hand a named person a seat.
   *
   * The containment rule is the point of the whole change: an `issuer` is
   * what the control plane holds instead of the setup code, and it may hand
   * out working seats but never an `owner` or another `issuer`. A stolen
   * control plane can then take the mouse on the boxes it knows, which is
   * bad, rather than own them forever, which is unrecoverable.
   */
  issue(
    opts: {
      role: Role;
      subject?: string;
      ttlMs?: number;
      display?: number;
      methods?: string[];
      label?: string;
    },
    by: PrincipalRecord,
    now = Date.now(),
  ): PrincipalRecord {
    if (by.role !== "owner" && by.role !== "issuer") {
      throw new ComputerError("DENIED", "only an owner or an issuer may issue a seat");
    }
    if (by.role === "issuer" && PRIVILEGED_ROLES.includes(opts.role)) {
      throw new ComputerError("DENIED", `an issuer may not issue the ${opts.role} role`);
    }
    if (opts.role === "bot" || opts.role === "ingress") {
      // Those come from CreateBot and the channel registry, which own the
      // rest of the record. Minting one here would make a token with no Bot.
      throw new ComputerError("VALIDATION", `the ${opts.role} role is not issued as a seat`);
    }
    const ttl = opts.ttlMs === undefined ? undefined : Math.min(opts.ttlMs, ISSUED_MAX_TTL_MS);
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw new ComputerError("VALIDATION", "ttl must be a positive number of milliseconds");
    }
    return this.mint({
      created_at: new Date(now).toISOString(),
      display: opts.display,
      expires_at: ttl === undefined ? undefined : new Date(now + ttl).toISOString(),
      kind: "user",
      label: opts.label,
      methods: opts.methods,
      role: opts.role,
      subject: opts.subject,
    });
  }

  /** Drop a token. Idempotent: revoking twice, or an unknown token, is not an error. */
  revoke(token: string): boolean {
    const had = this.records.delete(token);
    if (had) {
      this.persist();
    }
    return had;
  }

  /** Drop every expired grant. Reads already do this lazily; the sweep keeps the file small. */
  sweep(now = Date.now()): number {
    let dropped = 0;
    for (const [token, record] of this.records) {
      if (record.expires_at && Date.parse(record.expires_at) <= now) {
        this.records.delete(token);
        dropped += 1;
      }
    }
    if (dropped > 0) {
      this.persist();
    }
    return dropped;
  }

  /** Every live principal, tokens included: for the owner's own audit and revoke UI, never a public route. */
  listSeats(now = Date.now()): PrincipalRecord[] {
    this.sweep(now);
    return [...this.records.values()];
  }

  /**
   * Persist before returning. A token handed to a phone that never reached
   * disk is worse than a failed pairing: the phone believes it is paired and
   * the next restart says otherwise, which is the bug this store exists for.
   */
  private mint(record: Omit<PrincipalRecord, "token">): PrincipalRecord {
    // Spread the optional fields in only when set. An explicit `undefined`
    // serialises as an absent key anyway, but it leaves the record awkward to
    // compare and the file noisy to read.
    const full: PrincipalRecord = {
      created_at: record.created_at,
      kind: record.kind,
      role: record.role,
      token: randomBytes(24).toString("base64url"),
      ...(record.subject === undefined ? {} : { subject: record.subject }),
      ...(record.expires_at === undefined ? {} : { expires_at: record.expires_at }),
      ...(record.display === undefined ? {} : { display: record.display }),
      ...(record.methods === undefined ? {} : { methods: record.methods }),
      ...(record.label === undefined ? {} : { label: record.label }),
    };
    this.records.set(full.token, full);
    this.persist();
    return full;
  }

  private persist(): void {
    this.store.save([...this.records.values()]);
  }
}

/**
 * A Bot's token is a principal too, it just lives in the roster beside the
 * display it drives. Synthesised per call rather than stored, so `CreateBot`
 * and `DeleteBot` stay the only things that write the roster.
 */
function botPrincipal(token: string, botId: string): PrincipalRecord {
  return {
    created_at: "1970-01-01T00:00:00.000Z",
    kind: "bot",
    role: "bot",
    subject: botId,
    token,
  };
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
