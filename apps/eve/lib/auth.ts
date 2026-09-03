import { timingSafeEqual } from "node:crypto";
import { UnauthenticatedError, withAuthChallenges } from "eve/channels/auth";
import type { AuthFn } from "eve/channels/auth";

/** Header the hub injects on loopback `/eve/v1` proxy requests. */
export const EVE_HUB_SECRET_HEADER = "x-computer-eve-secret";

/**
 * An env secret, or undefined when the variable is unset, empty, or blank.
 *
 * One owner for that rule, because two variables are read at three doors and
 * the copies had already drifted: `resolveBridge` read a whitespace-only
 * `WHATSAPP_BRIDGE_SECRET` as no credential at all, while the inbound check
 * read the same value as a live secret, so a header of those same blanks
 * opened the route.
 *
 * The value comes back untrimmed on purpose. A secret is compared byte for
 * byte, and trimming here would stop matching a secret whose file on the
 * guest ends in a newline; only the is-there-one decision looks past the
 * whitespace.
 */
export function secretFromEnv(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = env[key];
  return secret?.trim() ? secret : undefined;
}

export function eveHubSecretFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return secretFromEnv("COMPUTER_EVE_SECRET", env);
}

export function eveHubSecretMatches(
  provided: string | null | undefined,
  expected: string | undefined,
): boolean {
  if (!provided || !expected) {
    return false;
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Production (`eve start`) authenticator: the hub already gated on the seat
 * token. Trust only the shared secret it injects. Does not use `localDev()` /
 * `EVE_DEV=1`, that path is ignored by `eve start`.
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
    if (!eveHubSecretMatches(provided, secret)) {
      return null;
    }
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
