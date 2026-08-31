import { randomBytes, timingSafeEqual } from "node:crypto";
import { ComputerError } from "@computer/shared";
import type { AuthPolicy } from "@computer/proto";

export type TokenKind = "agent" | "seat";

export class AuthRegistry {
  private readonly setupCode: string;
  private readonly agentToken: string;
  private readonly seatTokens = new Set<string>();

  constructor(opts: { setupCode: string; agentToken: string }) {
    if (!opts.setupCode) throw new Error("COMPUTER_SETUP_CODE is required");
    if (!opts.agentToken) throw new Error("COMPUTER_AGENT_TOKEN is required");
    this.setupCode = opts.setupCode;
    this.agentToken = opts.agentToken;
  }

  pair(code: string): string {
    if (!safeEqual(code, this.setupCode)) {
      throw new ComputerError("UNAUTHENTICATED", "bad setup code");
    }
    const token = randomBytes(24).toString("base64url");
    this.seatTokens.add(token);
    return token;
  }

  verify(policy: AuthPolicy, bearer: string | undefined): TokenKind | "public" {
    if (policy === "public" || policy === "pair") return "public";
    if (!bearer) throw new ComputerError("UNAUTHENTICATED", "missing bearer");
    if (policy === "agent") {
      if (!safeEqual(bearer, this.agentToken)) {
        throw new ComputerError("UNAUTHENTICATED", "bad bearer");
      }
      return "agent";
    }
    if (policy === "seat") {
      if (this.seatTokens.has(bearer) || safeEqual(bearer, this.agentToken)) {
        // agent token may Status for debug; pointer still needs the seat FSM
        return this.seatTokens.has(bearer) ? "seat" : "agent";
      }
      throw new ComputerError("UNAUTHENTICATED", "bad bearer");
    }
    throw new ComputerError("UNAUTHENTICATED", "unknown policy");
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

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
