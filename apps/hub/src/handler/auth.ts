import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError } from "@computer/shared";
import type { AuthPolicy } from "@computer/proto";

export type TokenKind = "agent" | "seat";

export type Verified = { kind: TokenKind | "public"; botId?: string };

export class AuthRegistry {
  private readonly setupCode: string;
  /** token → bot id. One entry per Bot; the token identifies the Bot. */
  private readonly agentTokens: Map<string, string>;
  private readonly seatTokens = new Set<string>();

  constructor(opts: { setupCode: string; agentToken?: string; agentTokens?: Map<string, string> }) {
    if (!opts.setupCode) throw new Error("COMPUTER_SETUP_CODE is required");
    this.setupCode = opts.setupCode;
    this.agentTokens = new Map(opts.agentTokens ?? []);
    if (opts.agentToken) this.agentTokens.set(opts.agentToken, "main");
    if (this.agentTokens.size === 0) throw new Error("COMPUTER_AGENT_TOKEN is required");
  }

  pair(code: string): string {
    if (!safeEqual(code, this.setupCode)) {
      throw new ComputerError("UNAUTHENTICATED", "bad setup code");
    }
    const token = randomBytes(24).toString("base64url");
    this.seatTokens.add(token);
    return token;
  }

  verify(policy: AuthPolicy, bearer: string | undefined): Verified {
    if (policy === "public" || policy === "pair") return { kind: "public" };
    if (!bearer) throw new ComputerError("UNAUTHENTICATED", "missing bearer");
    if (policy === "agent") {
      // Constant-time compare against every entry; no early exit on match.
      let botId: string | undefined;
      for (const [token, id] of this.agentTokens) {
        if (safeEqual(bearer, token)) botId = id;
      }
      if (botId === undefined) {
        throw new ComputerError("UNAUTHENTICATED", "bad bearer");
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

  /** Test helper */
  issueSeatToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.seatTokens.add(token);
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
