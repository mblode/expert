import type { ClientSessionState } from "eve/client";

/**
 * What survives a reload: the paired seat, and where the conversation got to.
 * Both are per-browser; the seat token is the box owner's credential, so this
 * is the same trust boundary as staying signed in.
 */

const SEAT_KEY = "computer.web.seat";
const SESSION_KEY = "computer.web.session";

export type StoredSeat = { hubUrl: string; seatToken: string };

function read<T>(key: string, valid: (value: unknown) => value is T): T | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return valid(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown): void {
  try {
    if (value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full quota: the app still works, it just forgets.
  }
}

export function loadSeat(): StoredSeat | undefined {
  return read(
    SEAT_KEY,
    (v): v is StoredSeat =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as StoredSeat).hubUrl === "string" &&
      typeof (v as StoredSeat).seatToken === "string",
  );
}

export function saveSeat(seat: StoredSeat): void {
  write(SEAT_KEY, seat);
}

export function clearSeat(): void {
  write(SEAT_KEY, undefined);
  write(SESSION_KEY, undefined);
}

export function loadSession(): ClientSessionState | undefined {
  return read(
    SESSION_KEY,
    (v): v is ClientSessionState =>
      typeof v === "object" &&
      v !== null &&
      typeof (v as ClientSessionState).sessionId === "string" &&
      typeof (v as ClientSessionState).streamIndex === "number",
  );
}

export function saveSession(session: ClientSessionState | undefined): void {
  write(SESSION_KEY, session);
}
