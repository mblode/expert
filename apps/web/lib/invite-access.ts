import { timingSafeEqual } from "node:crypto";

import type { EnvMap } from "./computers";
import { isComputerOperator } from "./computers";

/** Header the invite pages send. The token is never logged here. */
export const INVITE_HEADER = "x-computer-invite";

/** Eve's mint client (`vcmc-agent` `expert-invite.ts`) sends this, not Bearer. */
export const INVITE_SECRET_HEADER = "x-invite-secret";

export function inviteTokenFromRequest(request: Request, body?: unknown): string {
  const header = request.headers.get(INVITE_HEADER)?.trim();
  if (header) {
    return header;
  }
  if (body && typeof body === "object" && "invite" in body && typeof body.invite === "string") {
    return body.invite.trim();
  }
  return "";
}

/** Either env name is the mint secret. Both may be set to the same value. */
export function mintSecrets(env: EnvMap): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of ["EXPERT_INVITE_SECRET", "INVITE_MINT_SECRET"] as const) {
    const value = env[name]?.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

function bearerToken(header: string | null): string {
  if (!header) {
    return "";
  }
  const match = /^Bearer\s+(\S+)$/iu.exec(header.trim());
  return match?.[1] ?? "";
}

function offeredMintSecrets(request: Request): string[] {
  const header = request.headers.get(INVITE_SECRET_HEADER)?.trim() ?? "";
  const bearer = bearerToken(request.headers.get("authorization"));
  return [header, bearer].filter(Boolean);
}

function secretEquals(offered: string, allowed: string): boolean {
  const a = Buffer.from(offered);
  const b = Buffer.from(allowed);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

export function canMintInvite(
  request: Request,
  email: string | undefined,
  env: EnvMap = process.env,
): boolean {
  const allowed = mintSecrets(env);
  if (allowed.length > 0) {
    for (const offered of offeredMintSecrets(request)) {
      if (allowed.some((secret) => secretEquals(offered, secret))) {
        return true;
      }
    }
  }
  return Boolean(email && isComputerOperator(email, env));
}
