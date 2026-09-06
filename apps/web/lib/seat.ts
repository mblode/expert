/**
 * The Seat API, from a browser.
 *
 * The desktop stream is view-only by design: the X server refuses RFB input,
 * so every pointer, keystroke and clipboard operation in this app is one of
 * these RPCs. `display` picks the screen; absent means the primary one.
 */

import { DEFAULT_HUB_URL, trimSlashes } from "./config";

export interface RuntimeConfiguration {
  revision: number;
  instructions: string;
  memory_set: boolean;
  memory: string[];
  skills: { id: string; description: string; markdown: string }[];
}

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

/**
 * A Bot's profile, as the hub stores it on the box.
 *
 * The mark is two closed sets and the client checks them too: the colour
 * lands in an inline style, and the file the hub reads it from is one the
 * model can rewrite with `write_file`. The hub clamps on the way out; this
 * is the same check at the other end, not a second opinion about the value.
 */
export const AVATAR_SHAPES = [
  "circle",
  "square",
  "hexagon",
  "diamond",
  "squircle",
  "blob",
  "tablet",
  "wedge",
] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];

export const AVATAR_COLORS = [
  "#e5484d",
  "#f76b15",
  "#f5d90a",
  "#46a758",
  "#0091ff",
  "#8e4ec6",
  "#9159fe",
  "#1084fe",
  "#00c972",
  "#ff6700",
  "#777777",
  "#000000",
] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export interface BotProfile {
  id: string;
  name: string;
  /** The one-line label under the name. "Label" in the UI; `title` on the wire. */
  title: string;
  description: string;
  avatar_shape: AvatarShape;
  avatar_color: AvatarColor;
}

/**
 * A Bot's whole setup as one document: what `Seat.ExportBotTemplate` hands
 * back and what `Seat.ApplyBotTemplate` writes onto a Bot.
 *
 * Mirrored from `BotTemplate` in `packages/shared`, the way the avatar sets
 * above are, because this app does not depend on that package. The hub clamps
 * on both sides of the wire; `lib/bot-template.ts` is this end's own clamp,
 * for the stretch where a template is a row in Turso and a page served to
 * whoever has the link.
 */
export interface BotTemplateSkill {
  id: string;
  name: string;
  use_when: string;
  body: string;
}

export interface BotTemplateRoutine {
  id: string;
  title: string;
  cron: string;
  prompt: string;
}

export interface BotTemplatePlugin {
  name: string;
  url: string;
  auth: "static" | "oauth";
}

/** What `Seat.ExportBotTemplate` answers with. */
interface ExportedTemplate {
  template: BotTemplate;
  /** Whether the rewrite ran. False under a generic request means read it. */
  generic: boolean;
  /** One sentence: what was left out, or why the rewrite did not happen. */
  note: string;
}

export interface BotTemplate {
  version: number;
  name: string;
  title: string;
  description: string;
  avatar_shape: AvatarShape;
  avatar_color: AvatarColor;
  instructions: string;
  memories: string[];
  skills: BotTemplateSkill[];
  routines: BotTemplateRoutine[];
  plugins: BotTemplatePlugin[];
}

/** What the roster route reports per Bot. Owner seats only. */
interface RosterBot {
  id: string;
  display: number;
  state: SeatState;
  profile: BotProfile;
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

/**
 * One call to the hub, RPC or plain route. The roster is a GET rather than a
 * Seat method, and it reports the same error envelope, so it wants the same
 * error handling rather than its own.
 */
async function send<T>(hubUrl: string, path: string, token: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase(hubUrl)}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: body === undefined ? "GET" : "POST",
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
    throw new SeatError(envelope?.message ?? `${path} failed (${res.status})`, envelope?.code);
  }
  return payload as T;
}

function rpc<T>(hubUrl: string, method: string, body: unknown, token: string): Promise<T> {
  return send<T>(hubUrl, `/computer.v1.Seat/${method}`, token, body);
}

export type Seat = ReturnType<typeof createSeat>;

interface WorkConversation {
  id: string;
  bot: string;
  updated_at: string;
  last_seq: number;
  route: { kind: string; repo?: string; agent?: string; jid?: string };
}
export interface CodingSession {
  conversation_id: string;
  agent: string;
  repo: string;
  state: "pending" | "active" | "awaitingInput" | "complete" | "error" | "stale";
  url: string;
  branch: string;
  pr_url: string;
  summary: string;
}

export function createSeat(hubUrl: string, token: string) {
  const call = <T>(method: string, body: Record<string, unknown>): Promise<T> =>
    rpc<T>(hubUrl, method, body, token);

  return {
    conversations: (display?: number) =>
      call<{ conversations: WorkConversation[] }>("Conversations", { display }),
    occurrences: (conversation_id: string, cursor?: string) =>
      call<{ entries: { id: string; kind: string; text?: string; prompt?: string }[] }>(
        "Occurrences",
        { conversation_id, cursor, limit: 100 },
      ),
    startCoding: (input: {
      source_conversation_id?: string;
      display: number;
      repo: string;
      prompt: string;
      request_id: string;
      auto_create_pr: boolean;
    }) => call<CodingSession>("StartCodingSession", input),
    refreshCoding: (conversation_id: string) =>
      call<CodingSession>("RefreshCodingSession", { conversation_id }),
    click: (button: Button, display?: number) =>
      call<unknown>("Pointer", { type: "click", button, display }),
    clipboardGet: (display?: number) => call<{ text: string }>("ClipboardGet", { display }),
    /**
     * Answer an open `secret_request`. The value goes to the box clipboard and
     * nowhere else: not the thread, not the reply, not the model. Once per
     * request; the hub refuses a replay.
     */
    provideSecret: (occurrence_id: string, value: string, display?: number) =>
      call<{ provided: boolean }>("ProvideSecret", { display, occurrence_id, value }),
    /**
     * Make a Bot on the computer. Owner-only, and the id is what the box
     * calls it forever: the name a person typed is the profile, written
     * straight after this with `setBotProfile`.
     *
     * The token in the reply is minted once and is the new Bot's own
     * credential. Nothing in this app keeps it: the guest hands it to that
     * Bot's Eve, and a client holding an agent token would be a client that
     * can act as the Bot.
     */
    createBot: (id: string) =>
      call<{ display: number; id: string; token: string }>("CreateBot", { id }),
    clipboardSet: (text: string, display?: number) =>
      call<{ text: string }>("ClipboardSet", { text, display }),
    /**
     * A Bot's setup as one portable document, read off the computer it runs
     * on. Owner-only, and it carries what the Bot remembers, so what is
     * published from it is ticked by the person looking at it rather than
     * decided here.
     *
     * `generic` asks the computer to rewrite it for a stranger: the same
     * assistant with the person taken out of it. The reply says whether that
     * rewrite actually ran, because a document that still names you, handed
     * back under a flag that says it does not, is the one answer worse than
     * refusing.
     */
    exportBotTemplate: (id: string, generic = false) =>
      call<ExportedTemplate>("ExportBotTemplate", { generic, id }),
    /**
     * Write a template onto a Bot on this computer. Replaces that Bot's
     * brief, skills, routines and plugin list, and appends to its memory, so
     * it is called on a Bot that was just made rather than on one at work.
     */
    applyBotTemplate: (id: string, template: BotTemplate) =>
      call<BotProfile>("ApplyBotTemplate", { id, template }),
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
    /**
     * Every Bot with its profile. Owner-only, and a box read per Bot, so it
     * is what a client calls when the roster changes rather than on a poll.
     */
    roster: () => send<{ bots: RosterBot[] }>(hubUrl, "/roster", token),
    /** The whole profile, not a patch: an empty title or description clears it. */
    setBotProfile: (profile: BotProfile) => call<BotProfile>("SetBotProfile", { ...profile }),
    configureAssistant: (
      id: string,
      configuration: {
        operation: "read" | "replace" | "undo";
        base_revision?: number;
        instructions?: string;
        memory?: string[];
      },
    ) => call<RuntimeConfiguration>("ConfigureAssistant", { id, configuration }),
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
