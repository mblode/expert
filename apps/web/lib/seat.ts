/**
 * The Seat API, from a browser.
 *
 * The desktop stream is view-only by design: the X server refuses RFB input,
 * so every pointer, keystroke and clipboard operation in this app is one of
 * these RPCs. `display` picks the screen; absent means the primary one.
 */

import { DEFAULT_HUB_URL, trimSlashes } from "./config";

export type SeatState = "AGENT" | "WAITING" | "HUMAN";

/**
 * Where the box says its cursor actually is, after a move. Exported because it
 * is what `Seat.move` resolves to.
 *
 * @public
 */
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

/** The buttons `Seat.click` accepts. @public */
export type Button = "left" | "right" | "middle" | "back" | "forward";

/**
 * WhatsApp as a channel. The hub mediates every call to the bridge process
 * on the computer; the browser never talks to the bridge itself. `acct` names
 * a linked number (one today, `main`), `bot` the Bot it belongs to.
 */
export type WhatsAppStatus = "unlinked" | "linking" | "open" | "closed";

export interface WhatsAppAccount {
  acct: string;
  bot: string;
  phone: string | null;
  status: WhatsAppStatus;
}

/**
 * What `WhatsAppLink` returns for `start`, `status` and `unlink`. While
 * `linking`, one of `qr` (the raw string, rotated every 20 to 60 s) or
 * `pairing_code` (eight characters, when `start` carried a phone) is set.
 */
export interface WhatsAppLinkState {
  acct: string;
  status: WhatsAppStatus;
  qr: string | null;
  pairing_code: string | null;
  age_ms: number | null;
  phone: string | null;
}

export interface WhatsAppGroup {
  jid: string;
  subject: string;
  size: number;
  enabled: boolean;
}

export interface WhatsAppConfig {
  /** "all" serves every group the number is in; "listed" serves only `allowed_groups`. */
  group_policy?: "all" | "listed";
  allowed_groups: string[];
  trigger_mode: "mention" | "prefix" | "all";
  trigger_prefix?: string;
  dm_policy: "members" | "allowlist" | "anyone";
  dm_allowlist?: string[];
  image_sends_per_day?: number;
  vision_enabled?: boolean;
  maintainer_jid?: string;
  owner_jids?: string[];
  digest_recipient_jids?: string[];
  bot_name?: string;
}

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
    /** Sign-out: end this seat on the hub. No argument revokes the caller's own token. */
    revoke: () => call<{ revoked: boolean }>("Revoke", {}),
    whatsappAccounts: () => call<{ accounts: WhatsAppAccount[] }>("WhatsAppAccounts", {}),
    /** Get when `config` is absent, set when present; either way the stored config comes back. */
    whatsappConfig: (acct: string) => call<{ config: WhatsAppConfig }>("WhatsAppConfig", { acct }),
    whatsappGroups: (acct: string) => call<{ groups: WhatsAppGroup[] }>("WhatsAppGroups", { acct }),
    /** `invite` is the code from a `chat.whatsapp.com` link. */
    whatsappJoinGroup: (acct: string, invite: string) =>
      call<{ jid: string }>("WhatsAppJoinGroup", { acct, invite }),
    /**
     * `start` with a phone (digits only, no plus) asks for a pairing code;
     * without one it yields a QR. `start` on an account that does not exist
     * creates it against `bot` (default `main`). `unlink` logs the device out.
     */
    whatsappLink: (
      acct: string,
      action: "start" | "status" | "unlink",
      extra: { phone?: string; bot?: string } = {},
    ) => call<WhatsAppLinkState>("WhatsAppLink", { acct, action, ...extra }),
    whatsappSetConfig: (acct: string, config: WhatsAppConfig) =>
      call<{ config: WhatsAppConfig }>("WhatsAppConfig", { acct, config }),
  };
}
