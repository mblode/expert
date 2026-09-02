/**
 * The Seat API, from a browser.
 *
 * The desktop stream is view-only by design: the X server refuses RFB input,
 * so every pointer, keystroke and clipboard operation in this app is one of
 * these RPCs. `display` picks the screen; absent means the primary one.
 */

import { DEFAULT_HUB_URL, trimSlashes } from "./config";

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

/** Where the box says its cursor actually is, after a move. */
export interface PointerResponse {
  cursor: { x: number; y: number };
  seat: SeatState;
}

export interface Screen {
  bot_id: string;
  display: number;
  state: SeatState;
  vnc_url: string;
}

export interface BoxStatus {
  state: SeatState;
  vnc_url: string;
  display: { width: number; height: number; scale: number };
  screens: Screen[];
}

export type Button = "left" | "right" | "middle" | "back" | "forward";

export class SeatError extends Error {
  readonly code: string;

  constructor(message: string, code = "UNKNOWN") {
    super(message);
    this.name = "SeatError";
    this.code = code;
  }
}

/**
 * Where to send Seat RPCs.
 *
 * `next dev` rewrites the hub onto this origin. In production the Vercel
 * app talks cross-origin to the hub on the session (Blode is the
 * fallback); the hub echoes CORS on JSON.
 */
const PROXY_TARGET = process.env.NEXT_PUBLIC_HUB_PROXY_TARGET ?? "";
const PUBLIC_HUB = trimSlashes(
  process.env.NEXT_PUBLIC_HUB_URL || (process.env.VERCEL ? DEFAULT_HUB_URL : ""),
);

export function apiBase(hubUrl: string): string {
  const base = trimSlashes(hubUrl || PUBLIC_HUB);
  if (PROXY_TARGET && base && sameOrigin(base, PROXY_TARGET)) {
    return "";
  }
  return base;
}

/** Remint window, keep the iframe src while more than this remains. */
const PIXEL_REFRESH_MS = 60_000;

/** True while the stamped pixel grant still has enough time left. */
export function pixelUrlFresh(
  vncUrl: string,
  now = Date.now(),
  minRemainingMs = PIXEL_REFRESH_MS,
): boolean {
  try {
    const expires = Number(new URL(vncUrl).searchParams.get("expires"));
    return Number.isFinite(expires) && expires - now > minRemainingMs;
  } catch {
    return false;
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a, window.location.origin).origin === new URL(b, window.location.origin).origin;
  } catch {
    return false;
  }
}

async function rpc<T>(hubUrl: string, method: string, body: unknown, token: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(hubUrl)}/computer.v1.Seat/${method}`, {
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    throw new SeatError(
      `cannot reach the hub at ${hubUrl || window.location.origin}`,
      "DAEMON_DOWN",
    );
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new SeatError(envelope?.message ?? `${method} failed (${res.status})`, envelope?.code);
  }
  return payload as T;
}

export type Seat = ReturnType<typeof createSeat>;

export function createSeat(hubUrl: string, token: string) {
  const call = <T>(method: string, body: Record<string, unknown>): Promise<T> =>
    rpc<T>(hubUrl, method, body, token);

  return {
    click: (button: Button, display?: number) =>
      call<unknown>("Pointer", { type: "click", button, display }),
    clipboardGet: (display?: number) => call<{ text: string }>("ClipboardGet", { display }),
    clipboardSet: (text: string, display?: number) =>
      call<{ text: string }>("ClipboardSet", { text, display }),
    hubUrl,
    /** `grab` holds the left button down across moves, that is how a drag works. */
    move: (dx: number, dy: number, grab: boolean, display?: number) =>
      call<PointerResponse>("Pointer", { type: "move", dx, dy, grab, display }),
    scroll: (dx: number, dy: number, display?: number) =>
      call<unknown>("Pointer", { type: "scroll", dx, dy, display }),
    /** `present: false` is "I'm done": it hands the seat back to the agent. */
    setPresence: (present: boolean, display?: number) =>
      call<BoxStatus>("SetPresence", { present, display }),
    status: (display?: number) => call<BoxStatus>("Status", { display }),
    token,
    /** Pasted, not synthesized per-key: the hub types via clipboard + ctrl-v. */
    type: (text: string, display?: number) => call<unknown>("Type", { text, display }),
  };
}
