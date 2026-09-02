import type { ClientSessionState } from "eve/client";

/**
 * What survives a reload: where each Bot's conversation got to. The seat token
 * itself is never stored here: it rides on the auth session.
 */

const SESSION_KEY = "computer.web.session";

function read<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return undefined;
    }
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Private browsing or a full quota: the app still works, it just forgets.
  }
}

function sessionKey(botId: string): string {
  return `${SESSION_KEY}.${botId}`;
}

export function loadSession(botId: string): ClientSessionState | undefined {
  return read(
    sessionKey(botId),
    (v): v is ClientSessionState =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as ClientSessionState).sessionId === "string" &&
      typeof (v as ClientSessionState).streamIndex === "number",
  );
}

export function saveSession(session: ClientSessionState | undefined, botId: string): void {
  write(sessionKey(botId), session);
}

/** Sign-out: forget every Bot's cursor so the next person here starts fresh. */
export function clearSessions(): void {
  try {
    const prefix = `${SESSION_KEY}.`;
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(prefix)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      window.localStorage.removeItem(key);
    }
  } catch {
    // Same as write(): private browsing or a full quota.
  }
}
