/**
 * Who may make an account outright: `AUTH_ALLOWED_EMAILS`, comma-separated,
 * case-insensitive. Unset means open, which is only right for a private
 * deployment; `lib/auth.ts` warns about it in production.
 */
export function allowedEmailSet(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return new Set(
    (env.AUTH_ALLOWED_EMAILS ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAllowedEmail(
  email: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const allowed = allowedEmailSet(env);
  return allowed.size === 0 || allowed.has(email.trim().toLowerCase());
}
