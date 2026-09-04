/**
 * Branded IDs, error codes, and invariants shared by hub.
 * Behaviour source of truth: api/DESIGN.md
 */

export type PixelX = number & { readonly __brand: "PixelX" };
export type PixelY = number & { readonly __brand: "PixelY" };

export const DISPLAY = { height: 800, scale: 1, width: 1280 } as const;
export type Display = typeof DISPLAY;

/** Window index = X display number. Primary is :1; forks are :2+. */
export const MAX_DISPLAYS = 8 as const;
export const PRIMARY_DISPLAY = 1 as const;

export type BotId = string & { readonly __brand: "BotId" };

export function asBotId(s: string): BotId {
  return s as BotId;
}

/**
 * A Bot's profile: the name it answers to, its one-line label, what it is
 * for, and the mark a human recognises it by. It lives on the box at
 * `/workspace/.bots/<id>/profile.json` and the hub folds it into that Bot's
 * system prompt, so it is identity rather than decoration.
 *
 * The mark is two closed sets rather than free text. The model can rewrite
 * the file itself with `write_file`, and a colour reaches a client as an
 * inline style, so the palette is the boundary that keeps a colour a colour.
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

/**
 * Lower case, and every value in both sets is only ever appended to. A mark
 * is stored, not derived: dropping an entry, or changing its case, silently
 * falls a Bot that already wears it back to the seeded default.
 */
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

/** Snake_cased like the rest of the on-box JSON: the file is the wire shape. */
export interface BotProfile {
  id: string;
  name: string;
  title: string;
  description: string;
  avatar_shape: AvatarShape;
  avatar_color: AvatarColor;
}

/**
 * Length caps, applied on the way in and again on the way out. The file is
 * the model's to rewrite, so a hub that only validated writes would still
 * hand a client whatever the agent left there.
 */
export const BOT_PROFILE_MAX = { description: 500, name: 48, title: 64 } as const;

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
 * What a guest seat may call unless the invite narrows it further. Never
 * provisioning, the thread, or clipboard read.
 *
 * A seat is held by a principal with a role (see `ROLES` below). An `owner`
 * paired with the setup code and may do anything a seat can. A `guest` came
 * from an invite the Bot handed out in a chat: bound to one display, limited
 * to the methods below, and expiring, so a WhatsApp member can take the mouse
 * for a few minutes without becoming the box owner.
 */
export const SEAT_GUEST_METHODS = [
  "/computer.v1.Seat/Status",
  "/computer.v1.Seat/SetPresence",
  "/computer.v1.Seat/Pointer",
  "/computer.v1.Seat/Type",
  "/computer.v1.Seat/ClipboardSet",
  "/computer.v1.Seat/ProvideSecret",
  "/computer.v1.Seat/Revoke",
] as const;

/**
 * Who is calling. Every bearer the hub accepts resolves to one of these, so
 * there is one verify path rather than one per door: a human at a seat, a
 * Bot's Eve holding an agent token, and a service like the WhatsApp bridge or
 * the control plane. Before this, a seat token, a bot token and a connector
 * secret were three unrelated checks over three files, and none of them knew
 * which human was behind a seat.
 */
export type PrincipalKind = "user" | "bot" | "service";

/**
 * What a principal may do, as a named bundle of methods.
 *
 * `owner` is unrestricted inside the Seat service, which is what a paired
 * seat has always been: a new RPC is available to owners the moment it is
 * registered. Every other role is an explicit allowlist, so a new RPC is
 * denied to them until someone decides otherwise. That asymmetry is the
 * point: adding a method must never quietly widen a narrow role.
 */
export const ROLES = [
  "owner",
  "operator",
  "viewer",
  "guest",
  "installer",
  "bot",
  "issuer",
  "ingress",
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can mint other principals. An issuer may never hand out one of these. */
export const PRIVILEGED_ROLES: readonly Role[] = ["owner", "issuer"];

const SEAT_CREATE_BOT = "/computer.v1.Seat/CreateBot";
const SEAT_DELETE_BOT = "/computer.v1.Seat/DeleteBot";
const SEAT_OCCURRENCES = "/computer.v1.Seat/Occurrences";
const SEAT_STATUS = "/computer.v1.Seat/Status";
const SEAT_REVOKE = "/computer.v1.Seat/Revoke";
const SEAT_ISSUE = "/computer.v1.Seat/Issue";

/**
 * What a connection file costs to author, and nothing else.
 *
 * There is no seat-shaped way to write a file: `Agent.WriteFile` takes an
 * agent token, so authoring one means `CreateBot`, write as that Bot, then
 * `DeleteBot`. Before this role the control plane asked for an `owner`
 * narrowed by `methods` to these three, because `owner` was the only thing
 * carrying `CreateBot`. That worked and was the wrong shape: `methods` is a
 * narrowing mechanism, not a role definition, so the next route gated on the
 * role rather than the method handed a plugins invite the whole box.
 *
 * Read the containment honestly. A Bot token is `shell` on the box, so an
 * installer is one call away from running code there; what it never gets is
 * the owner's HTTP doors (the Eve thread, `/roster`, the pixel stream), the
 * clipboard, WhatsApp linking, `Issue`, or any seat but its own to revoke.
 * It is a short-lived grant to do one job, not a safe role.
 */
export const SEAT_INSTALLER_METHODS = [SEAT_CREATE_BOT, SEAT_DELETE_BOT, SEAT_REVOKE] as const;

/**
 * Methods per role. `undefined` means unrestricted within the service the
 * principal's policy already gates, never "every method on the hub": an
 * agent token is still refused by a seat-policy route and vice versa.
 *
 * Revoke is in every human role deliberately. Ending your own seat is not a
 * privilege, and sign-out calls it.
 */
export const ROLE_METHODS: Record<Role, readonly string[] | undefined> = {
  guest: SEAT_GUEST_METHODS,
  installer: SEAT_INSTALLER_METHODS,
  // A person who may drive the box but not reshape it: no CreateBot, no
  // WhatsApp linking, no clipboard read (it exfiltrates whatever is copied).
  operator: [...SEAT_GUEST_METHODS, SEAT_OCCURRENCES],
  owner: undefined,
  viewer: [SEAT_STATUS, SEAT_OCCURRENCES, SEAT_REVOKE],
  // The control plane: it exists to hand seats to people it has authenticated.
  issuer: [SEAT_ISSUE, SEAT_REVOKE],
  bot: undefined,
  // A door, not a caller: the connector ingress is its whole surface. The
  // role keeps its name through the connector rename: it says what shape of
  // principal this is (an inbound door), not which object opened it.
  ingress: [],
};

/**
 * Does this role, narrowed by `methods` if the grant narrows it, allow `method`?
 *
 * Both lists have to say yes. `methods` narrows and never widens: naming a
 * method the role does not carry refuses it rather than promoting it. An
 * earlier version read `methods ?? ROLE_METHODS[role]`, so a grant replaced
 * the role's allowlist instead of intersecting with it, and every role with
 * a finite list could be widened by the grant that was supposed to shrink
 * it. An issuer, which may not hand out `owner`, could mint
 * `role: "operator", methods: ["/computer.v1.Provision/CreateBot"]` and get
 * a bot token, and a bot token is `shell` on the box.
 *
 * Unrestricted therefore means both are absent, which is a bare owner.
 */
export function principalAllows(
  role: Role,
  methods: readonly string[] | undefined,
  method: string | undefined,
): boolean {
  for (const allowed of [ROLE_METHODS[role], methods]) {
    if (allowed === undefined) {
      continue;
    }
    if (method === undefined || !allowed.includes(method)) {
      return false;
    }
  }
  return true;
}

/**
 * Closed on the way in, additive on the way out.
 *
 * model→hub stays strict: an unknown action type or send kind is VALIDATION,
 * loudly, because a typo in a tool call is a bug the model must see. But
 * hub→client is the opposite direction and grows: DENIED joined this union,
 * `denied` joined ActionResult, and `reason`/`phase` ride along on the error
 * envelope. A client that hard-fails on an unrecognised ErrorCode or
 * ActionResult kind breaks on the next hub release, degrade to the generic
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
  CONFLICT: 409,
  DAEMON_DOWN: 503,
  DENIED: 403,
  OUT_OF_BOUNDS: 400,
  PATH_REJECTED: 400,
  SEAT_HELD: 409,
  UNAUTHENTICATED: 401,
  VALIDATION: 400,
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

export interface Unavailable {
  reason: UnavailableReason;
  phase: UnavailablePhase;
  /** Client contract. False only when no amount of retrying will bind a route. */
  retryable: boolean;
}

/** route_missing means there is nothing to attach to; everything else may come back. */
export function unavailable(reason: UnavailableReason, phase: UnavailablePhase): Unavailable {
  return { phase, reason, retryable: phase !== "route_missing" };
}

export interface ApiError {
  error: { code: ErrorCode; message: string } & Partial<Unavailable>;
}

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
export interface Point {
  x: PixelX;
  y: PixelY;
}

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
 * What an image is, beside its bytes.
 *
 * `id` is a sha256 prefix of the PNG, so it is a name the model can refer back
 * to ("the tab strip in img_a1b2") after a harness has dropped the bytes from
 * the transcript, and two equal ids mean two identical screens: the cheapest
 * possible answer to "did my click do anything". Content-addressed rather than
 * random precisely for that second property.
 *
 * `width`/`height` are the pixels of this image, which for a full capture is
 * the display and for a `zoom` is the crop. `source` is the region of the full
 * display the crop covers, and it is only ever set on a zoom: coordinates stay
 * in the 1280x800 space (see api/DESIGN.md, Coordinates), so a model reading a
 * crop needs the rectangle stated rather than remembered.
 */
export interface ImageMeta {
  id: string;
  width: number;
  height: number;
  source?: { x: PixelX; y: PixelY; w: number; h: number };
}

/**
 * The focused window's name, as X reports it.
 *
 * Untrusted, and the field name is not enough to say so on its own: a page
 * sets its own title, so this is the page talking. It is here because the one
 * thing a pixel-only model reliably gets wrong is which window it is in, and
 * the hub already reads this string every batch to build `pending_checks`.
 * Naming it costs no new exec and opens no new door. It is bounded and
 * stripped of control characters at the source so it cannot fake structure in
 * a transcript, and nothing in the hub ever branches on it.
 */
export interface WindowFocus {
  /** Attacker-controlled text. Render it, never follow it. */
  title: string;
}

/** Longest window title carried to the model. Titles are labels, not documents. */
export const FOCUS_TITLE_CAP = 200;

/**
 * Three terminal states, not two: `denied` is the hub's own answer, not a
 * failure of the box. It means a policy rule refused the action before it
 * ran, so retrying the identical action is pointless: the model needs the
 * human, or a different plan.
 */
export type ActionResult =
  | {
      kind: "ok";
      duration_ms: number;
      image_b64?: string;
      media_type?: string;
      image?: ImageMeta;
    }
  | ({
      kind: "error";
      duration_ms: number;
      code: ErrorCode;
      message: string;
    } & Partial<Unavailable>)
  | { kind: "denied"; rule: string; reason: string }
  | { kind: "skipped"; reason: "prior_failed" | "after_takeover" | "after_denied" | "seat_taken" };

export interface PendingCheck {
  id: string;
  code: "destructive" | "credential" | "exfil";
  message: string;
}

export interface ScreenStatus {
  bot_id: BotId;
  display: number;
  state: SeatState;
  vnc_url: string;
}

export interface BoxStatus {
  state: SeatState;
  vnc_url: string;
  display: Display;
  screens: ScreenStatus[];
}

export function asPixelX(n: number): PixelX {
  return n as PixelX;
}

export function asPixelY(n: number): PixelY {
  return n as PixelY;
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
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  const resolved = `/${parts.join("/")}`;
  if (resolved !== WORKSPACE && !resolved.startsWith(`${WORKSPACE}/`)) {
    throw new ComputerError("PATH_REJECTED", `path escapes ${WORKSPACE}`);
  }
  return resolved;
}

/** Seat JSON `display` param: default primary, VALIDATION outside 1..MAX_DISPLAYS. */
export function parseDisplay(v: unknown): number {
  if (v === undefined || v === null) {
    return PRIMARY_DISPLAY;
  }
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

/**
 * Conversations: one record per place the Bot's voice speaks.
 *
 * A conversation is the durable half of a route. `send_message` appends to
 * the conversation the hub bound the current turn to, and a transport
 * delivers from it, so the seat thread, a WhatsApp chat and (later) a peer
 * hop are one object with three routes rather than three code paths.
 *
 * The route kinds are a const in the style of `OCCURRENCE_KINDS`: the union
 * is derived from it, so a new kind is one edit and a file on disk carrying
 * an unknown one is rejected on read rather than silently mounted.
 */
export const CONVERSATION_ROUTE_KINDS = ["seat", "whatsapp", "peer", "code"] as const;
export type ConversationRouteKind = (typeof CONVERSATION_ROUTE_KINDS)[number];

/**
 * Where messages leave for. `peer` is bot-to-bot and has no writer yet.
 *
 * `code` is a coding session, and it is the one route whose other end is not
 * a person: `repo` is the repository the work runs against and `agent` is the
 * durable handle the runner gave it. It is a route rather than a table
 * because the thing a client wants is the thread, and a session that reports
 * progress into the same log as everything else needs no second reader.
 */
export type Route =
  | { kind: "seat" }
  | { kind: "whatsapp"; acct: string; jid: string }
  | { kind: "peer"; bot: string }
  | { kind: "code"; repo: string; agent: string };

/**
 * How a coding session is doing, in the vocabulary Linear's agent sessions
 * already spell: a client that learns these words here can render a Linear
 * session later without a translation layer. `stale` covers cancelled and
 * expired, which are the same thing to someone reading the thread: nobody is
 * working on it and nothing more is coming.
 */
export type CodingSessionState =
  | "pending"
  | "active"
  | "awaitingInput"
  | "complete"
  | "error"
  | "stale";

/**
 * Who is in the conversation. `ref` is the human's identity on the route: a
 * WhatsApp JID here, a seat subject once the seat route lands.
 */
export type Participant =
  | { kind: "bot"; bot: string }
  | { kind: "human"; ref: string; display_name?: string };

/** Who wrote a message. `system` carries hop notices and route failures. */
export type Author =
  | { kind: "bot"; bot: string }
  | { kind: "human"; ref: string }
  | { kind: "system" };

/**
 * Exactly today's occurrence bodies with `id`, `seq` and `at` lifted out.
 * Not one new kind: the turn rules that hang off `widget` and
 * `secret_request` are unchanged, they just become per conversation.
 */
export type MessageBody =
  | { kind: "human"; text: string }
  | { kind: "text"; text: string; images: string[] }
  | { kind: "widget"; prompt: string; options: string[]; answer: string | null }
  | { kind: "secret_request"; prompt: string; label: string; provided: boolean };

export interface Message {
  /** The existing `occ_<...>` shape, unchanged. */
  id: string;
  conversation_id: string;
  /** Per conversation, monotonic, survives restart. */
  seq: number;
  at: number;
  author: Author;
  body: MessageBody;
  /** Set for anything a turn produced. */
  turn_id?: string;
  /**
   * The id of the `widget` or `secret_request` this message closes.
   *
   * A widget's `answer` and a secret_request's `provided` are resolution
   * state, and the log is append-only: the line that recorded the request
   * is never rewritten. So the answer is carried by the message that
   * answers it, and the two fields are derived on read. Without this a
   * person simply typing after a widget would look like an answer to it.
   */
  resolves?: string;
}

export interface Conversation {
  /** `conv_<base64url>`. */
  id: string;
  /** Whose voice speaks here. */
  bot: string;
  route: Route;
  participants: Participant[];
  /** Mirrors the log tail, so a list needs no file read. */
  last_seq: number;
  created_at: string;
  updated_at: string;
  /**
   * The path the pre-conversations occurrence log was imported from, set
   * once the import has run. It is the marker that keeps the import
   * one-shot, and it lives in the index rather than in a file of its own so
   * that "the log was seeded" cannot drift from the log it seeded.
   */
  imported_from?: string;
}

/**
 * A routine, and the cron subset that decides when it is due.
 *
 * This lives here rather than in the hub because two processes have to agree
 * on the answer to the minute: the box's own alarm (`apps/hub/src/host/
 * routines.ts`), which wakes a sleeping Bot, and the clock outside the box
 * (`apps/clock`), which wakes the Machine so there is an alarm at all. A
 * second implementation of cron would be a routine that one of them thinks
 * fires and the other does not, which is silent by construction: nothing
 * errors, the morning brief simply never comes.
 */
export interface Routine {
  id: string;
  /** Standard 5-field cron, UTC, as the schedule file has it. */
  cron: string;
}

/**
 * The routines in a Bot's `agent/routines.json`, or none.
 *
 * Takes the text rather than the path: the hub reads one file it knows the
 * name of, the clock walks a directory of them, and neither wants the other's
 * filesystem. Anything that is not a routine this file can evaluate is
 * dropped rather than guessed at, because a cron nobody parses is a routine
 * that silently never runs.
 */
export function parseRoutines(raw: string): Routine[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (r): r is Routine =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as Routine).id === "string" &&
      typeof (r as Routine).cron === "string" &&
      validCron((r as Routine).cron),
  );
}

/**
 * Does this cron fire in the minute containing `at`?
 *
 * Five fields, UTC, and the subset of the syntax the schedules here use:
 * a star, a number, `a-b`, `a,b`, and a step written star-slash-n.
 * Anything else is refused by `validCron` on the way in rather than guessed
 * at. Day-of-month and day-of-week are OR'd when both are restricted, which
 * is the standard rule.
 */
export function cronMatches(cron: string, at: Date): boolean {
  const f = cron.trim().split(/\s+/u);
  if (f.length !== 5) {
    return false;
  }
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (
    !(
      matchesField(minute, at.getUTCMinutes(), CRON_BOUNDS[0]) &&
      matchesField(hour, at.getUTCHours(), CRON_BOUNDS[1])
    )
  ) {
    return false;
  }
  if (!matchesField(month, at.getUTCMonth() + 1, CRON_BOUNDS[3])) {
    return false;
  }
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const domHit = matchesField(dom, at.getUTCDate(), CRON_BOUNDS[2]);
  // Sunday is 0 and 7 in cron and `getUTCDay()` only ever says 0, so a field
  // written as `7` still has to match. A step is not tried at 7: counting
  // from the field minimum already covers Sunday at 0.
  const dowHit =
    matchesField(dow, at.getUTCDay(), CRON_BOUNDS[4]) ||
    (at.getUTCDay() === 0 && matchesField(dow.replaceAll(/\/\d+/gu, ""), 7, CRON_BOUNDS[4]));
  if (domRestricted && dowRestricted) {
    return domHit || dowHit;
  }
  return domHit && dowHit;
}

/**
 * Every field's own bounds, in cron's order. A step counts from the field's
 * minimum, not from zero, which is why they are here: a step of two in
 * day-of-month is the 1st, 3rd and 5th, and reading it as "even days" would
 * fire a routine on the wrong days for the life of the box. Day-of-week
 * allows 7 for Sunday.
 */
const CRON_BOUNDS = [
  { max: 59, min: 0 },
  { max: 23, min: 0 },
  { max: 31, min: 1 },
  { max: 12, min: 1 },
  { max: 7, min: 0 },
] as const;

/**
 * A cron this file can actually evaluate: five fields, each in range.
 *
 * Range-checked rather than shape-checked, because an unmatchable field
 * (minute 99) is a routine that never fires and says nothing, which is the
 * exact thing this module exists to prevent.
 */
export function validCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/u);
  if (f.length !== 5) {
    return false;
  }
  return f.every((field, i) => fieldValid(field, CRON_BOUNDS[i]!));
}

const CRON_FIELD = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/u;

interface CronBound {
  min: number;
  max: number;
}

function fieldValid(field: string, bound: CronBound): boolean {
  if (!CRON_FIELD.test(field)) {
    return false;
  }
  return field.split(",").every((part) => partValid(part, bound));
}

function partValid(part: string, bound: CronBound): boolean {
  const [range, stepRaw] = part.split("/");
  if (stepRaw !== undefined && !(Number(stepRaw) >= 1)) {
    return false;
  }
  if (range === "*") {
    return true;
  }
  const [fromRaw, toRaw] = (range ?? "").split("-");
  const from = Number(fromRaw);
  const to = toRaw === undefined ? from : Number(toRaw);
  return from >= bound.min && from <= bound.max && to >= from && to <= bound.max;
}

function matchesField(field: string, value: number, bound: CronBound): boolean {
  return field.split(",").some((part) => matchesPart(part, value, bound));
}

function matchesPart(part: string, value: number, bound: CronBound): boolean {
  const [range, stepRaw] = part.split("/");
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1) {
    return false;
  }
  if (range === "*") {
    return value >= bound.min && value <= bound.max && (value - bound.min) % step === 0;
  }
  const [fromRaw, toRaw] = (range ?? "").split("-");
  const from = Number(fromRaw);
  const to = toRaw === undefined && stepRaw === undefined ? from : Number(toRaw ?? bound.max);
  if (!(Number.isInteger(from) && Number.isInteger(to))) {
    return false;
  }
  return value >= from && value <= to && (value - from) % step === 0;
}
