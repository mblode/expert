/**
 * The Seat API, from a browser.
 *
 * The desktop stream is view-only by design — the X server refuses RFB input —
 * so every pointer, keystroke and clipboard operation in this app is one of
 * these RPCs. `display` picks the screen; absent means the primary one.
 */

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

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
 * Where to send requests for a given hub.
 *
 * In dev the vite server proxies the hub onto this origin, and same-origin
 * paths are the only thing that works: the hub answers the CORS preflight but
 * never echoes `access-control-allow-origin` on the response, so a
 * cross-origin `fetch` cannot read one. A build has no proxy and goes direct.
 */
export function apiBase(hubUrl: string): string {
  const base = hubUrl.trim().replace(/\/+$/u, "");
  if (__HUB_PROXY_TARGET__ && sameOrigin(base, __HUB_PROXY_TARGET__)) return "";
  return base;
}

/**
 * The hub hands back absolute `vnc_url`s. Re-point them at whatever base we
 * are actually talking to, so in dev the noVNC page — and the websocket it
 * opens back to `location.host` — travel through the same proxy.
 */
export function screenSrc(hubUrl: string, vncUrl: string): string {
  try {
    const url = new URL(vncUrl, window.location.origin);
    return `${apiBase(hubUrl)}${url.pathname}${url.search}`;
  } catch {
    return vncUrl;
  }
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
      call<unknown>("Pointer", { type: "move", dx, dy, grab, display }),
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
