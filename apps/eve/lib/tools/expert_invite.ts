import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import type { ToolContext } from "eve/tools";
import { z } from "zod";
import { chatFromAttributes } from "./whatsapp_send.ts";

/**
 * Mint a hello.expert desk or plugin link. WhatsApp cannot host a browser, so
 * a link is the only way a human takes the mouse or consents to a new plugin.
 *
 * The control plane mints it, not the hub: `POST /api/invite` on hello.expert
 * writes the invite row, and redeeming it there issues a guest seat bound to
 * one screen and to the link's own life (`apps/web/lib/invite.ts`). This side
 * holds one shared string, `EXPERT_INVITE_SECRET`, which says which computer
 * it may mint for and nothing else: it grants no seat, reads nothing, and the
 * URL that comes back is public by construction. Without it every call
 * degrades to the sign-in line rather than failing the turn.
 *
 * What it returns is checked before the model sees it, because the model puts
 * it straight into a chat: same origin as the one configured here, https, no
 * credentials in it. `docs/WHATSAPP-PARITY.md` Phase 2 moves the mint itself
 * onto the hub (`Agent.CreateInvite`, written to the thread as an occurrence)
 * so the owner sees every link handed out; the reply shape here is the one it
 * will keep.
 *
 * Not for changing instructions, skills, routines, or tools: those are files.
 * Edit them with `read_file` / `write_file`. Do not call this for an edit.
 */

/** Where the invites live when nothing says otherwise. */
const DEFAULT_EXPERT_ORIGIN = "https://hello.expert";

/**
 * How long a link lasts. Short on purpose: it is a person on a phone about to
 * type a password on a computer that other people can also be handed, so the
 * window is the task, not the day. The control plane's own ceiling is four
 * hours and this never asks for it.
 */
const TTL_MINUTES = 30;

/** Inside a chat turn a human is waiting on. */
const TIMEOUT_MS = 10_000;

type InviteKind = "desk" | "plugin";

type InviteResult =
  | { available: true; kind: InviteKind; url: string; expires_in_minutes: number }
  | { available: false; kind: InviteKind; note: string };

interface Minter {
  origin: string;
  secret: string;
}

/** Test seams, the same shape the bridge client uses. */
export interface InviteDeps {
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

/**
 * The control plane this Bot may mint against, or null when it holds no
 * secret for one. The secret is what gates it: an origin with no secret is a
 * route that answers 401, so there is nothing to try.
 */
export const resolveMinter = (env: NodeJS.ProcessEnv = process.env): Minter | null => {
  const secret = env.EXPERT_INVITE_SECRET?.trim();
  if (!secret) {
    return null;
  }
  const origin = (env.EXPERT_ORIGIN?.trim() || DEFAULT_EXPERT_ORIGIN).replace(/\/+$/u, "");
  return { origin, secret };
};

/** What the Bot says instead of a link. Never contains a token. */
export const unavailableNote = (origin = DEFAULT_EXPERT_ORIGIN): string => {
  const line = (host: string): string => `open ${host} and sign in, I can't mint a link from here`;
  try {
    const { host } = new URL(origin);
    return line(host);
  } catch {
    // A misconfigured origin must not become the address a member is sent to.
    return line(new URL(DEFAULT_EXPERT_ORIGIN).host);
  }
};

/**
 * The link, if it is one this Bot may repeat into a chat.
 *
 * The model pastes whatever comes back, so the answer is treated as untrusted
 * input rather than as this deployment's own word: a control plane that has
 * been pointed somewhere else, or an origin misread from the environment,
 * would otherwise hand a member a link to another host with a live seat token
 * in it. Same origin, https (or a loopback origin in development), no
 * userinfo, and the query and fragment dropped, because the token is a path
 * segment and everything else is somebody's tracking.
 */
export const publicInviteUrl = (raw: unknown, origin: string): string | null => {
  if (typeof raw !== "string" || !raw.trim()) {
    return null;
  }
  let url: URL;
  let home: URL;
  try {
    url = new URL(raw.trim());
    home = new URL(origin);
  } catch {
    return null;
  }
  if (url.origin !== home.origin || url.username || url.password) {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) {
    return null;
  }
  url.search = "";
  url.hash = "";
  return url.toString();
};

/**
 * Ask the control plane for a link. Never throws: the caller is a tool in the
 * middle of a chat turn, and a thrown error there costs the reply the human is
 * waiting for. Every failure is the same one-line fallback, because the model
 * has nothing useful to do with the difference between a 500 and a timeout.
 */
export const mintInvite = async (
  kind: InviteKind,
  sender: string | undefined,
  deps: InviteDeps = {},
): Promise<InviteResult> => {
  const minter = resolveMinter(deps.env ?? process.env);
  if (!minter) {
    return { available: false, kind, note: unavailableNote() };
  }
  const call = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await call(`${minter.origin}/api/invite`, {
      body: JSON.stringify({
        kind,
        // Hashed on arrival and never rendered: it is how the owner tells one
        // link's provenance from another, not a name in the record.
        ...(sender ? { sender } : {}),
        ttlMinutes: TTL_MINUTES,
      }),
      headers: { "content-type": "application/json", "x-invite-secret": minter.secret },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { available: false, kind, note: unavailableNote(minter.origin) };
  }
  if (!res.ok) {
    return { available: false, kind, note: unavailableNote(minter.origin) };
  }
  const body: unknown = await res.json().catch(() => null);
  const url = publicInviteUrl(
    body && typeof body === "object" ? (body as { url?: unknown }).url : null,
    minter.origin,
  );
  if (!url) {
    return { available: false, kind, note: unavailableNote(minter.origin) };
  }
  return { available: true, expires_in_minutes: TTL_MINUTES, kind, url };
};

export default defineTool({
  approval: never(),
  description:
    "Mint a short hello.expert link when a real browser is required: kind=desk if a human wants the mouse and keyboard (say 'Open the desk' or 'tap this to take over'), kind=plugin for OAuth consent on a new plugin (say 'Add a plugin'). Send the url back as it comes, on its own line, with one line saying what it is for; it expires. Not for changing instructions, skills, routines, or computer-use: edit those files on disk instead. Never put a token, setup code, or credential in the reply. If it returns available:false, say the note in one sentence and keep going.",
  execute(input: { kind: InviteKind }, ctx: ToolContext): Promise<InviteResult> {
    const chat = chatFromAttributes(ctx.session.auth.current?.attributes);
    return mintInvite(input.kind, chat?.jid);
  },
  inputSchema: z.object({
    kind: z
      .enum(["desk", "plugin"])
      .describe(
        "desk = a human takes the mouse. plugin = OAuth consent for a new connection. Never use this to edit instructions, skills, or routines.",
      ),
  }),
});
