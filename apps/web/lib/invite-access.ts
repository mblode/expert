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

/**
 * The caller is holding the mint secret rather than an operator session.
 *
 * Worth telling apart from `canMintInvite`, because the two doors carry
 * different authority. An operator is an account, so the catalog it may open
 * is already decided by `accessibleComputers`. The secret is one shared string
 * held by a Bot: it names nobody, so it inherits no binding, and what it may
 * mint for has to be pinned somewhere else (`mintSecretComputerId`).
 */
function holdsMintSecret(request: Request, env: EnvMap): boolean {
  const allowed = mintSecrets(env);
  if (allowed.length === 0) {
    return false;
  }
  return offeredMintSecrets(request).some((offered) =>
    allowed.some((secret) => secretEquals(offered, secret)),
  );
}

export function canMintInvite(
  request: Request,
  email: string | undefined,
  env: EnvMap = process.env,
): boolean {
  return holdsMintSecret(request, env) || Boolean(email && isComputerOperator(email, env));
}
