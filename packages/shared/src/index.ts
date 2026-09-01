/**
 * Branded IDs, error codes, and invariants shared by hub.
 * Behaviour source of truth: api/DESIGN.md
 */

export type PixelX = number & { readonly __brand: "PixelX" };
export type PixelY = number & { readonly __brand: "PixelY" };
export type RequestId = string & { readonly __brand: "RequestId" };

export const DISPLAY = { width: 1280, height: 800, scale: 1 } as const;
export type Display = typeof DISPLAY;

/** Window index = X display number. Primary is :1; forks are :2+. */
export const MAX_DISPLAYS = 8 as const;
export const PRIMARY_DISPLAY = 1 as const;

export type BotId = string & { readonly __brand: "BotId" };

export function asBotId(s: string): BotId {
  return s as BotId;
}

export const WORKSPACE = "/workspace" as const;
export const SPEC_ID = "computer.v1" as const;
export const SPEC_VERSION = "1.0.0" as const;
export const TOOLS = ["send_message", "computer", "shell", "read_file", "write_file"] as const;

/** Widget options the seat will render. 1..6, per the 0.18 card contract. */
export const MAX_WIDGET_OPTIONS = 6 as const;

/** Occurrence kinds in the per-Bot log the human actually sees. */
export const OCCURRENCE_KINDS = ["human", "text", "widget", "secret_request"] as const;
export type OccurrenceKind = (typeof OCCURRENCE_KINDS)[number];

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

/**
 * Closed on the way in, additive on the way out.
 *
 * model→hub stays strict: an unknown action type or send kind is VALIDATION,
 * loudly, because a typo in a tool call is a bug the model must see. But
 * hub→client is the opposite direction and grows: DENIED joined this union,
 * `denied` joined ActionResult, and `reason`/`phase` ride along on the error
 * envelope. A client that hard-fails on an unrecognised ErrorCode or
 * ActionResult kind breaks on the next hub release — degrade to the generic
 * case (treat it as an error, render the message) instead.
 */
export type ErrorCode =
  | "UNAUTHENTICATED"
  | "SEAT_HELD"
  | "OUT_OF_BOUNDS"
  | "PATH_REJECTED"
  | "DAEMON_DOWN"
  | "VALIDATION"
  | "CONFLICT"
  | "DENIED";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SEAT_HELD: 409,
  OUT_OF_BOUNDS: 400,
  PATH_REJECTED: 400,
  DAEMON_DOWN: 503,
  VALIDATION: 400,
  CONFLICT: 409,
  DENIED: 403,
};

/**
 * Why the box could not be reached, and whether trying again can help.
 *
 * "DAEMON_DOWN" alone tells a phone nothing it can act on. These three
 * fields are the first-party workspace_unavailable shape, restricted to
 * what this architecture can actually determine. The Fly edge emits
 * `hibernated` for a Status/roster read that must not wake the guest.
 */
export type UnavailableReason =
  | "idle_timeout"
  | "disconnect"
  | "shutdown"
  | "not_bound"
  | "instance_gone"
  | "hibernated"
  | "unknown";

export type UnavailablePhase = "in_flight_cancelled" | "route_missing" | "attach" | "unknown";

export type Unavailable = {
  reason: UnavailableReason;
  phase: UnavailablePhase;
  /** Client contract. False only when no amount of retrying will bind a route. */
  retryable: boolean;
};

/** route_missing means there is nothing to attach to; everything else may come back. */
export function unavailable(reason: UnavailableReason, phase: UnavailablePhase): Unavailable {
  return { reason, phase, retryable: phase !== "route_missing" };
}

export type ApiError = {
  error: { code: ErrorCode; message: string } & Partial<Unavailable>;
};

export class ComputerError extends Error {
  readonly code: ErrorCode;
  /** DAEMON_DOWN only: why, and whether a retry is worth it. */
  readonly detail?: Unavailable;

  constructor(code: ErrorCode, message: string, detail?: Unavailable) {
    super(message);
    this.name = "ComputerError";
    this.code = code;
    this.detail = detail;
  }

  toEnvelope(): ApiError {
    return { error: { code: this.code, message: this.message, ...this.detail } };
  }

  httpStatus(): number {
    return ERROR_HTTP_STATUS[this.code];
  }
}

export type Button = "left" | "right" | "middle" | "back" | "forward";
export type Point = { x: PixelX; y: PixelY };

export type Action =
  | { type: "screenshot" }
  | { type: "click"; x: PixelX; y: PixelY; button?: Button }
  | { type: "double_click"; x: PixelX; y: PixelY; button?: Button }
  | { type: "scroll"; x: PixelX; y: PixelY; dx: number; dy: number }
  | { type: "keypress"; keys: string[] }
  | { type: "type"; text: string }
  | { type: "move"; x: PixelX; y: PixelY }
  | { type: "drag"; path: Point[] }
  | { type: "wait"; ms: number }
  | { type: "zoom"; x: PixelX; y: PixelY; w: number; h: number }
  | { type: "request_takeover" };

/**
 * Three terminal states, not two: `denied` is the hub's own answer, not a
 * failure of the box. It means a policy rule refused the action before it
 * ran, so retrying the identical action is pointless — the model needs the
 * human, or a different plan.
 */
export type ActionResult =
  | { kind: "ok"; duration_ms: number; image_b64?: string; media_type?: string }
  | ({ kind: "error"; duration_ms: number; code: ErrorCode; message: string } & Partial<Unavailable>)
  | { kind: "denied"; rule: string; reason: string }
  | { kind: "skipped"; reason: "prior_failed" | "after_takeover" | "after_denied" };

export type PendingCheck = {
  id: string;
  code: "destructive" | "credential" | "exfil";
  message: string;
};

export type ScreenStatus = {
  bot_id: BotId;
  display: number;
  state: SeatState;
  vnc_url: string;
};

export type BoxStatus = {
  state: SeatState;
  vnc_url: string;
  display: Display;
  screens: ScreenStatus[];
};

export function asPixelX(n: number): PixelX {
  return n as PixelX;
}

export function asPixelY(n: number): PixelY {
  return n as PixelY;
}

export function asRequestId(s: string): RequestId {
  return s as RequestId;
}

export function asPoint(x: number, y: number): Point {
  return { x: asPixelX(x), y: asPixelY(y) };
}

export function inBounds(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    x < DISPLAY.width &&
    y >= 0 &&
    y < DISPLAY.height
  );
}

export function assertInBounds(x: number, y: number): void {
  if (!inBounds(x, y)) {
    throw new ComputerError("OUT_OF_BOUNDS", `coordinate ${x},${y} outside ${DISPLAY.width}x${DISPLAY.height}`);
  }
}

/** Absolute paths must start with /workspace. Relative paths resolve there. `..` after resolve is PATH_REJECTED. */
export function resolveWorkspacePath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new ComputerError("PATH_REJECTED", "path is required");
  }
  if (input.includes("\0")) {
    throw new ComputerError("PATH_REJECTED", "path contains NUL");
  }
  const joined = input.startsWith("/") ? input : `${WORKSPACE}/${input}`;
  const parts: string[] = [];
  for (const seg of joined.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = "/" + parts.join("/");
  if (resolved !== WORKSPACE && !resolved.startsWith(WORKSPACE + "/")) {
    throw new ComputerError("PATH_REJECTED", `path escapes ${WORKSPACE}`);
  }
  return resolved;
}

/** Seat JSON `display` param: default primary, VALIDATION outside 1..MAX_DISPLAYS. */
export function parseDisplay(v: unknown): number {
  if (v === undefined || v === null) return PRIMARY_DISPLAY;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPLAYS) {
    throw new ComputerError("VALIDATION", `display must be 1..${MAX_DISPLAYS}`);
  }
  return n;
}

export function clampCursor(x: number, y: number): Point {
  const cx = Math.min(DISPLAY.width - 1, Math.max(0, Math.round(x)));
  const cy = Math.min(DISPLAY.height - 1, Math.max(0, Math.round(y)));
  return asPoint(cx, cy);
}

export const ACTION_TYPES = [
  "screenshot",
  "click",
  "double_click",
  "scroll",
  "keypress",
  "type",
  "move",
  "drag",
  "wait",
  "zoom",
  "request_takeover",
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];
