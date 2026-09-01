/**
 * The Seat API, from a browser.
 *
 * The desktop stream is view-only by design — the X server refuses RFB input —
 * so every pointer, keystroke and clipboard operation in this app is one of
 * these RPCs. `display` picks the screen; absent means the primary one.
 */

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

/** Where the box says its cursor actually is, after a move. */
export type PointerResponse = { cursor: { x: number; y: number }; seat: SeatState };

export type Screen = {
  bot_id: string;
  display: number;
  state: SeatState;
  vnc_url: string;
};

export type BoxStatus = {
  state: SeatState;
  vnc_url: string;
  display: { width: number; height: number; scale: number };
  screens: Screen[];
};

export type PairResult = { token: string; vnc_url: string; status: BoxStatus };

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
 * app talks cross-origin to `NEXT_PUBLIC_HUB_URL` (the Fly computer); the
 * hub echoes CORS on JSON.
 */
const PROXY_TARGET = process.env.NEXT_PUBLIC_HUB_PROXY_TARGET ?? "";
/** Fly computer. Set `NEXT_PUBLIC_HUB_URL` on Vercel; used as the Vercel-build fallback. */
const FLY_HUB = "https://mblode-computer.fly.dev";
const PUBLIC_HUB = (
  process.env.NEXT_PUBLIC_HUB_URL || (process.env.VERCEL ? FLY_HUB : "")
).replace(/\/+$/u, "");

export function apiBase(hubUrl: string): string {
  const base = (hubUrl || PUBLIC_HUB).trim().replace(/\/+$/u, "");
  if (PROXY_TARGET && base && sameOrigin(base, PROXY_TARGET)) return "";
  return base;
}

/** Local-dev hub. Hosted pages use the env URL or the page origin. */
const LOCAL_HUB = "http://127.0.0.1:8787";

/** Remint window — keep the iframe src while more than this remains. */
export const PIXEL_REFRESH_MS = 60_000;

/**
 * Pair default: `NEXT_PUBLIC_HUB_URL` (Vercel → Fly), else the page origin
 * when hosted, else loopback for `next dev` / 127.0.0.1.
 */
export function defaultHubUrl(
  location?: { hostname: string; origin: string },
  publicHub = PUBLIC_HUB,
): string {
  const configured = publicHub.trim().replace(/\/+$/u, "");
  if (configured) return configured;
  if (!location) return LOCAL_HUB;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
    return LOCAL_HUB;
  }
  return location.origin;
}

/** True while the stamped pixel grant still has enough time left. */
export function pixelUrlFresh(vncUrl: string, now = Date.now(), minRemainingMs = PIXEL_REFRESH_MS): boolean {
  try {
    const expires = Number(new URL(vncUrl).searchParams.get("expires"));
    return Number.isFinite(expires) && expires - now > minRemainingMs;
  } catch {
    return false;
  }
}

/**
 * The hub hands back absolute `vnc_url`s, and they are used as-is.
 *
 * Do not route these through the dev proxy. noVNC opens an RFB websocket back
 * to whatever origin served the page, and a Next rewrite cannot carry a
 * WebSocket upgrade — proxied, the page would load and the socket would fail.
 * Pointing the iframe straight at the hub keeps page and socket on one origin.
 * It is a cross-origin iframe, which is fine: nothing here reads its document,
 * and the token is already in the URL the hub minted.
 */
export function screenSrc(_hubUrl: string, vncUrl: string): string {
  return vncUrl;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a, window.location.origin).origin === new URL(b, window.location.origin).origin;
  } catch {
    return false;
  }
}

async function rpc<T>(hubUrl: string, method: string, body: unknown, token?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(hubUrl)}/computer.v1.Seat/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SeatError(`cannot reach the hub at ${hubUrl || window.location.origin}`, "DAEMON_DOWN");
  }

  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const envelope = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new SeatError(envelope?.message ?? `${method} failed (${res.status})`, envelope?.code);
  }
  return payload as T;
}

export async function pair(hubUrl: string, code: string): Promise<PairResult> {
  return await rpc<PairResult>(hubUrl, "Pair", { code });
}

export type Seat = ReturnType<typeof createSeat>;

export function createSeat(hubUrl: string, token: string) {
  const call = <T>(method: string, body: Record<string, unknown>): Promise<T> =>
    rpc<T>(hubUrl, method, body, token);

  return {
    hubUrl,
    token,
    status: (display?: number) => call<BoxStatus>("Status", { display }),
    /** `present: false` is "I'm done" — it hands the seat back to the agent. */
    setPresence: (present: boolean, display?: number) =>
      call<BoxStatus>("SetPresence", { present, display }),
    /** `grab` holds the left button down across moves — that is how a drag works. */
    move: (dx: number, dy: number, grab: boolean, display?: number) =>
      call<PointerResponse>("Pointer", { type: "move", dx, dy, grab, display }),
    click: (button: Button, display?: number) =>
      call<unknown>("Pointer", { type: "click", button, display }),
    scroll: (dx: number, dy: number, display?: number) =>
      call<unknown>("Pointer", { type: "scroll", dx, dy, display }),
    /** Pasted, not synthesized per-key: the hub types via clipboard + ctrl-v. */
    type: (text: string, display?: number) => call<unknown>("Type", { text, display }),
    clipboardGet: (display?: number) => call<{ text: string }>("ClipboardGet", { display }),
    clipboardSet: (text: string, display?: number) =>
      call<{ text: string }>("ClipboardSet", { text, display }),
  };
}
