/**
 * computer.v1 — TypeScript view of DESIGN.md.
 * Hub implements this. Agents load spec.json. Proto is the wire.
 */

export type PixelX = number & { readonly __brand: "PixelX" };
export type PixelY = number & { readonly __brand: "PixelY" };
export type RequestId = string & { readonly __brand: "RequestId" };

export const DISPLAY = { width: 1280, height: 800, scale: 1 } as const;
export type Display = typeof DISPLAY;

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

/**
 * Closed on the way in, additive on the way out: model→hub validation stays
 * strict, but a client must degrade an ErrorCode or ActionResult kind it does
 * not know to the generic case rather than hard-failing on it.
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

/**
 * DAEMON_DOWN detail. `hibernated` and `idle_timeout` exist for wire
 * compatibility with the first-party shape; this box never emits them.
 * `retryable` is the client contract — false only when no route exists.
 */
export type Unavailable = {
  reason:
    | "idle_timeout"
    | "disconnect"
    | "shutdown"
    | "not_bound"
    | "instance_gone"
    | "hibernated"
    | "unknown";
  phase: "in_flight_cancelled" | "route_missing" | "attach" | "unknown";
  retryable: boolean;
};

export type ApiError = {
  error: { code: ErrorCode; message: string } & Partial<Unavailable>;
};

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

/** Three terminal states: `denied` is the hub refusing, not the box failing. */
export type ActionResult =
  | { kind: "ok"; duration_ms: number; image_b64?: string }
  | ({ kind: "error"; duration_ms: number; code: ErrorCode; message: string } & Partial<Unavailable>)
  | { kind: "denied"; rule: string; reason: string }
  | { kind: "skipped"; reason: "prior_failed" | "after_takeover" | "after_denied" };

export type PendingCheck = {
  id: string;
  code: "destructive" | "credential" | "exfil";
  message: string;
};

/** Model tools. The phone never calls these. */
export interface Agent {
  spec(): Promise<{
    id: "computer.v1";
    version: string;
    display: Display;
    workspace: "/workspace";
    tools: ["computer", "shell", "read_file", "write_file"];
  }>;
  computer(req: { request_id: RequestId; actions: Action[] }): Promise<{
    results: ActionResult[];
    screenshot_b64?: string;
    display: Display;
    cursor?: Point;
    seat: SeatState;
    pending_checks: PendingCheck[];
  }>;
  shell(req: {
    request_id: RequestId;
    argv: string[];
    cwd?: string;
    timeout_sec?: number;
  }): Promise<{
    exit: number;
    stdout: string;
    stderr: string;
    stdout_truncated: boolean;
    stderr_truncated: boolean;
  }>;
  readFile(req: { path: string }): Promise<{ content: string }>;
  writeFile(req: { path: string; content: string }): Promise<{ bytes: number }>;
}

/**
 * iPhone. The model never calls these.
 * `display` selects a screen (window index = X display number, 1..MAX_DISPLAYS).
 * Omitted means the primary screen (:1). The seat FSM is per screen.
 */
export interface Seat {
  pair(req: { code: string }): Promise<{
    token: string;
    vnc_url: string;
    status: BoxStatus;
  }>;
  status(req?: { display?: number }): Promise<BoxStatus>;
  setPresence(req: { present: boolean; display?: number }): Promise<BoxStatus>;
  /** `grab` holds the left button across a move — a drag from the trackpad. */
  pointer(
    req:
      | { type: "move"; dx: number; dy: number; grab?: boolean; display?: number }
      | { type: "click"; button?: Button; display?: number }
      | { type: "scroll"; dx: number; dy: number; display?: number },
  ): Promise<{ cursor: Point; seat: SeatState }>;
  type(req: { text: string; display?: number }): Promise<{ cursor: Point; seat: SeatState }>;
  clipboardGet(req?: { display?: number }): Promise<{ text: string }>;
  clipboardSet(req: { text: string; display?: number }): Promise<{ text: string }>;
  /** Provisioning: a paired seat is the box owner. The token appears exactly once. */
  createBot(req: { id: string }): Promise<{ id: string; display: number; token: string }>;
  deleteBot(req: { id: string }): Promise<BoxStatus>;
}

/** Window index = X display number. Primary is :1; forks are :2+. */
export const MAX_DISPLAYS = 8 as const;

/** One Bot's screen on the shared box. Bots are not security boundaries. */
export type ScreenStatus = {
  bot_id: string;
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
