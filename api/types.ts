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

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "SEAT_HELD"
  | "OUT_OF_BOUNDS"
  | "PATH_REJECTED"
  | "DAEMON_DOWN"
  | "VALIDATION"
  | "CONFLICT";

export type ApiError = { error: { code: ErrorCode; message: string } };

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

export type ActionResult =
  | { kind: "ok"; duration_ms: number; image_b64?: string }
  | { kind: "error"; duration_ms: number; code: ErrorCode; message: string }
  | { kind: "skipped"; reason: "prior_failed" | "after_takeover" };

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
  pointer(
    req:
      | { type: "move"; dx: number; dy: number; display?: number }
      | { type: "click"; button?: Button; display?: number },
  ): Promise<{ cursor: Point; seat: SeatState }>;
  type(req: { text: string; display?: number }): Promise<{ cursor: Point; seat: SeatState }>;
  clipboardGet(req?: { display?: number }): Promise<{ text: string }>;
  clipboardSet(req: { text: string; display?: number }): Promise<{ text: string }>;
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
  screens?: ScreenStatus[];
};
