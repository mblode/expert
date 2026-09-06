import type { AuthFn } from "eve/channels/auth";

/**
 * A fixture auth strategy for `eve eval`, gated behind an env flag production
 * never sets.
 *
 * Why it exists: `eve eval` boots a local dev server and sends no credentials,
 * so every session lands on eve's `localDev()`, whose context is a fixed
 * `{ attributes: {} }`. `groupJidFromAuth()` therefore returns `null` for the
 * whole eval suite, and every group-scoped path — the memory block injected into
 * the prompt, `save-memory`, `revert-memory`, `memory-log`, `audit-memory` —
 * takes its degraded no-group branch. Nothing about memory is testable.
 *
 * This lifts the same three identity fields the WhatsApp bridge sets (see
 * `agent/channels/whatsapp.ts`, which builds the identical auth shape from its
 * POST body) off request headers instead, so an eval can drive a session that
 * genuinely carries a group JID:
 *
 *   t.send("...", { headers: { "x-eval-chat-jid": jid } })
 *
 * `SendTurnOptions.headers` (per-request headers on the client send) reaches
 * route auth, which is what makes this reachable from an eval at all. Before
 * eve 0.49 the same thing was `t.send({ message, headers })`.
 *
 * SECURITY — this is an auth surface, so read the gate carefully:
 *
 *   - It is off unless `EVE_EVAL_FIXTURES` is explicitly set. No header, host,
 *     origin or other request-derived signal can turn it on. That is deliberate:
 *     eve hardened its own `localDev()` in 0.30.0 precisely because a spoofable
 *     `Host` header used to be enough to obtain local-dev access. Gating on
 *     anything the caller controls reintroduces exactly that bug, and here the
 *     prize is bigger — an attacker would pick their own `groupJid` and read or
 *     write another group's memory.
 *   - The flag is never set on the Vercel deployment. With it unset this returns
 *     `null` for every request, so `agent/channels/eve.ts` behaves byte-for-byte
 *     as it did before, falling straight through to `localDev()` / `vercelOidc()`
 *     / `placeholderAuth()`.
 *   - Mounted *ahead of* `localDev()` so that when the flag is on it wins; with
 *     it off, being first costs nothing.
 */

/** Request headers an eval uses to declare who it is sending as. */
export const EVAL_AUTH_HEADERS = {
  /** The chat/group JID the session should be scoped to. Required. */
  chatJid: "x-eval-chat-jid",
  /** Sender JID; becomes the principal id, as the bridge's `sender` does. */
  sender: "x-eval-sender",
  /** Sender display name. */
  senderName: "x-eval-sender-name",
  /** Phone-based sender identity, which is what admin gating matches on. */
  senderPhone: "x-eval-sender-phone",
} as const;

/**
 * Whether fixture auth is armed. Read per-request rather than at module load so
 * a test can flip it, and so it can never be baked into a build.
 */
const evalFixturesEnabled = (): boolean => {
  const raw = process.env.EVE_EVAL_FIXTURES?.trim().toLowerCase();
  return raw === "1" || raw === "true";
};

const header = (request: Request, name: string): string | undefined =>
  request.headers.get(name)?.trim() || undefined;

/**
 * An `AuthFn` that builds a session identity from `x-eval-*` headers, or `null`
 * when the flag is off or no chat JID was supplied. Returning `null` for a
 * flagless request is the whole safety property — see the module comment.
 */
export const evalHeaderAuth = (): AuthFn<Request> => (request: Request) => {
  if (!evalFixturesEnabled()) {
    return null;
  }
  const groupJid = header(request, EVAL_AUTH_HEADERS.chatJid);
  if (!groupJid) {
    // Armed but not addressed: leave the session to `localDev()` so evals that
    // don't want a group keep behaving exactly as they do today.
    return null;
  }
  const sender = header(request, EVAL_AUTH_HEADERS.sender);
  const senderName = header(request, EVAL_AUTH_HEADERS.senderName);
  const senderPhone = header(request, EVAL_AUTH_HEADERS.senderPhone);
  return {
    attributes: {
      groupJid,
      ...(senderName ? { senderName } : {}),
      ...(senderPhone ? { senderPhone } : {}),
    },
    authenticator: "eval-fixture",
    // Mirrors the bridge: with no explicit sender the chat itself is the
    // principal, which is what a DM from an unresolved contact looks like.
    principalId: sender ?? groupJid,
    principalType: "user",
  };
};
