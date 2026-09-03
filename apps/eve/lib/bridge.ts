/**
 * The Bot's side of the WhatsApp bridge's outbound envelope.
 *
 * Inbound is `lib/channels/bridge-protocol.ts`: the bridge POSTs a message
 * here and the reply rides back in the same response. That path can only ever
 * be one plain bubble of text. Everything else a chat wants (quoting the
 * message being answered, a reaction, a file with a name on it) is
 * `POST /send-envelope` on the bridge, and this module is the only thing on
 * this side that speaks it.
 *
 * The shapes are restated rather than imported. `apps/whatsapp-bridge` is a
 * separate workspace and not a dependency of this one, the same reason the
 * inbound validator is hand-written; and the bridge re-validates every field
 * on arrival, so nothing here re-implements a rule it owns. A cap or a policy
 * duplicated on this side would be a second copy to drift.
 *
 * Credential: `WHATSAPP_BRIDGE_SECRET`, the same shared secret guarding the
 * bridge's other routes. The hub's supervisor deliberately keeps it out of an
 * Eve child's environment (`DENY` in `apps/hub/src/host/init.ts`: Eve shares a
 * uid with the model's `shell`, so anything in its environ is the model's
 * too), so on the Fly guest this resolves to null today and every send
 * degrades to `available: false`. That is the intended state until Phase 3 of
 * `docs/WHATSAPP-PARITY.md` mints a per-inbound reply capability, a credential
 * narrow enough for a Bot to hold: one JID, one message, an expiry. Where the
 * direct door is already configured (an eve TUI, a bridge with no hub in
 * front) the same env makes sends live with no other change.
 */

/** What a media item is: a picture in the chat, or a file with a name on it. */
export type EnvelopeMediaKind = "image" | "document";

export interface EnvelopeMedia {
  kind: EnvelopeMediaKind;
  mime: string;
  base64: string;
  /** Required for a document; WhatsApp renders a file by its name. */
  filename?: string;
  caption?: string;
}

/** One outbound envelope, exactly the bridge's shape plus the account routing. */
export interface SendEnvelope {
  jid: string;
  /** Short message id to quote, from an inbound payload's `messageId`. */
  reply_to?: string;
  text?: string;
  react?: { to: string; emoji: string };
  media?: EnvelopeMedia[];
  /** Which linked number to send from. Omitted when the bridge has only one. */
  acct?: string;
}

/**
 * Why a send did not happen, in the two categories a model can act on.
 *
 * `malformed` is the caller's input (a 400): the same call repeated fails the
 * same way, a corrected one may not. `refused` is a rule or a spent budget on
 * the bridge (a 403): unquoted text into a group, a message id from another
 * chat, the daily cap. Repeating that one is pure noise. `unreachable` is
 * everything that is not an answer about this envelope (no credential, no
 * bridge, a timeout, a 5xx), which is the case that degrades rather than
 * telling the model to change anything.
 */
export type EnvelopeFailure = "malformed" | "refused" | "unreachable";

export type EnvelopeSendResult =
  | { ok: true; messageIds: string[] }
  | { ok: false; kind: EnvelopeFailure; reason: string };

/** Where `apps/hub/src/host/init.ts` starts the bridge when nothing says otherwise. */
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:2100";

/**
 * A send carries base64 files and waits on a WhatsApp socket, so it is slower
 * than a plain API call; it is also inside a chat turn a human is waiting on,
 * so it cannot wait long. Well under the bridge's own 40 s agent timeout.
 */
const TIMEOUT_MS = 20_000;

export interface BridgeTarget {
  base: string;
  secret: string;
}

/**
 * The bridge this process may call, or null when it holds no credential for
 * one. The secret is what gates it: a base URL with no secret is a route that
 * answers 401, so there is nothing to try. `COMPUTER_BRIDGE_URL` is the name
 * the hub's supervisor uses, `BRIDGE_URL` the one `vcmc-agent` ships with.
 */
export const resolveBridge = (env: NodeJS.ProcessEnv = process.env): BridgeTarget | null => {
  const secret = env.WHATSAPP_BRIDGE_SECRET?.trim();
  if (!secret) {
    return null;
  }
  const base = (
    env.COMPUTER_BRIDGE_URL?.trim() ||
    env.BRIDGE_URL?.trim() ||
    DEFAULT_BRIDGE_URL
  ).replace(/\/+$/u, "");
  return { base, secret };
};

/** Injection points so the tests drive this without a socket or an env. */
export interface BridgeDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

/** The bridge's answer, in the two fields this side reads. */
interface EnvelopeResponse {
  sent?: boolean;
  message_ids?: unknown;
  error?: unknown;
}

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

/**
 * Map a bridge status onto a failure category. 401 is a misconfigured secret
 * and 404 an older bridge with no envelope route: neither is something the
 * model can fix or should hear about as a refusal, so both degrade like an
 * unreachable bridge. 413 is a body over the media cap, which is the caller's
 * input and so belongs with the 400s.
 */
const failureFor = (status: number): EnvelopeFailure => {
  if (status === 403) {
    return "refused";
  }
  if (status === 400 || status === 413) {
    return "malformed";
  }
  return "unreachable";
};

/**
 * POST one envelope. Never throws: every outcome, including a dead bridge, is
 * a value, because the caller is a tool in the middle of a chat turn and a
 * thrown error there costs the reply the human is waiting for.
 */
export const postEnvelope = async (
  envelope: SendEnvelope,
  deps: BridgeDeps = {},
): Promise<EnvelopeSendResult> => {
  const target = resolveBridge(deps.env ?? process.env);
  if (!target) {
    return {
      kind: "unreachable",
      ok: false,
      reason: "this Bot holds no WhatsApp bridge credential",
    };
  }
  const call = deps.fetch ?? fetch;
  let res: Response;
  try {
    res = await call(`${target.base}/send-envelope`, {
      body: JSON.stringify(envelope),
      headers: {
        "content-type": "application/json",
        "x-bridge-secret": target.secret,
      },
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const why =
      error instanceof Error && error.name === "TimeoutError"
        ? "did not answer in time"
        : "is not reachable";
    // The base is loopback and the secret never leaves this function, so the
    // reason can name where it tried without leaking anything.
    return { kind: "unreachable", ok: false, reason: `the WhatsApp bridge ${why}` };
  }
  const text = await res.text();
  let body: EnvelopeResponse | null = null;
  try {
    body = text ? (JSON.parse(text) as EnvelopeResponse) : null;
  } catch {
    // Not JSON: the status is the whole diagnosis.
  }
  if (res.ok && body?.sent) {
    return { messageIds: stringList(body.message_ids), ok: true };
  }
  const reason =
    typeof body?.error === "string" && body.error.trim()
      ? body.error.trim()
      : `the bridge answered ${res.status}`;
  return { kind: failureFor(res.status), ok: false, reason };
};
