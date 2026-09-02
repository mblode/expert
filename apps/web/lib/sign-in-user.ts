/** Pull a person off a Better Auth sign-in payload without a follow-up getSession. */
export function userFromSignIn(data: unknown): { id: string; email?: string } | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const record = data as Record<string, unknown>;
  const raw = record.user && typeof record.user === "object" ? record.user : data;
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const user = raw as Record<string, unknown>;
  if (typeof user.id !== "string" || !user.id) {
    return undefined;
  }
  return {
    id: user.id,
    ...(typeof user.email === "string" && user.email ? { email: user.email } : {}),
  };
}
