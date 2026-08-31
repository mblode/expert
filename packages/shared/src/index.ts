/**
 * Branded IDs, error codes, and invariants shared by hub.
 * Behaviour source of truth: api/DESIGN.md
 */

export type PixelX = number & { readonly __brand: "PixelX" };
export type PixelY = number & { readonly __brand: "PixelY" };
export type RequestId = string & { readonly __brand: "RequestId" };

export const DISPLAY = { width: 1280, height: 800, scale: 1 } as const;
export type Display = typeof DISPLAY;

export const WORKSPACE = "/workspace" as const;
export const SPEC_ID = "computer.v1" as const;
export const SPEC_VERSION = "1.0.0" as const;
export const TOOLS = ["computer", "shell", "read_file", "write_file"] as const;

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

export type ErrorCode =
  | "UNAUTHENTICATED"
  | "SEAT_HELD"
  | "OUT_OF_BOUNDS"
  | "PATH_REJECTED"
  | "DAEMON_DOWN"
  | "VALIDATION"
  | "CONFLICT";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  SEAT_HELD: 409,
  OUT_OF_BOUNDS: 400,
  PATH_REJECTED: 400,
  DAEMON_DOWN: 503,
  VALIDATION: 400,
  CONFLICT: 409,
};

export type ApiError = { error: { code: ErrorCode; message: string } };

export class ComputerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ComputerError";
    this.code = code;
  }

  toEnvelope(): ApiError {
    return { error: { code: this.code, message: this.message } };
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

export type ActionResult =
  | { kind: "ok"; duration_ms: number; image_b64?: string; media_type?: string }
  | { kind: "error"; duration_ms: number; code: ErrorCode; message: string }
  | { kind: "skipped"; reason: "prior_failed" | "after_takeover" };

export type PendingCheck = {
  id: string;
  code: "destructive" | "credential" | "exfil";
  message: string;
};

export type BoxStatus = {
  state: SeatState;
  vnc_url: string;
  display: Display;
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
