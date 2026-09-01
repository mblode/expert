import { timingSafeEqual } from "node:crypto";
import { type AuthFn, UnauthenticatedError, withAuthChallenges } from "eve/channels/auth";

/** Header the hub injects on loopback `/eve/v1` proxy requests. */
export const EVE_HUB_SECRET_HEADER = "x-computer-eve-secret";

export function eveHubSecretFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = env.COMPUTER_EVE_SECRET;
  return secret && secret.length > 0 ? secret : undefined;
}

export function eveHubSecretMatches(
  provided: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Production (`eve start`) authenticator: the hub already gated on the seat
 * token. Trust only the shared secret it injects. Does not use `localDev()` /
 * `EVE_DEV=1` — that path is ignored by `eve start`.
 */
export function hubLoopbackAuth(
  secret: string | undefined = eveHubSecretFromEnv(),
): AuthFn<Request> {
  const verify: AuthFn<Request> = (request) => {
    if (!secret) {
      throw new UnauthenticatedError({
        code: "authentication_required",
        message: "COMPUTER_EVE_SECRET is not set",
      });
    }
    const provided = request.headers.get(EVE_HUB_SECRET_HEADER);
    if (!eveHubSecretMatches(provided, secret)) return null;
    return {
      attributes: { via: "hub" },
      authenticator: "computer-hub",
      issuer: "computer-hub",
      principalId: "hub",
      principalType: "service",
    };
  };
  return withAuthChallenges(verify, [{ scheme: "Bearer" }]);
}
