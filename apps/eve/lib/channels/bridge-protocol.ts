/**
 * Bridge protocol v1: what the WhatsApp bridge POSTs to a Bot's Eve.
 *
 * The bridge (a Baileys process the hub supervises, see
 * `docs/WHATSAPP-PARITY.md` Section 3) is the only thing that speaks this
 * shape, and both ends pin the version so a field can be added without either
 * side guessing. Hand-written validation rather than zod: the payload is small,
 * every field but two is optional, and a validator with no schema dependency
 * is one the bridge workspace can copy verbatim.
 */

export const BRIDGE_PROTOCOL_VERSION = 1;

/** One attached image, as a data URL so the model can see it without a fetch. */
export interface BridgeMedia {
  mime?: string;
  dataUrl?: string;
}

export interface BridgePayload {
  /** WhatsApp chat JID (`...@g.us` for a group, `...@s.whatsapp.net` for a DM). */
  token: string;
  /** The message text to hand to the agent. */
  message: string;
  /** Sender JID, for attribution. */
  sender?: string;
  /** The sender's phone-based identity (Baileys `senderPn`), for allowlists. */
  senderPhone?: string;
  /** Display name of the sender, surfaced to the agent as context. */
  senderName?: string;
  /** Extra context blocks from the bridge (recent messages, shared links). */
  context?: string[];
  /** Where the message came from. Absent on old bridges, treated as a group. */
  surface?: "dm" | "group";
  /** Images attached to the message. */
  media?: BridgeMedia[];
  /**
   * Which linked number this arrived on. The bridge is multi-account, one
   * socket per `acct`, so a Bot with two numbers can tell them apart.
   */
  acct?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const optionalString = (
  body: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; error: string } => {
  const value = body[key];
  if (value === undefined || value === null) {
    return { ok: true, value: undefined };
  }
  if (typeof value !== "string") {
    return { error: `${key} must be a string`, ok: false };
  }
  return { ok: true, value };
};

/**
 * Validates an inbound bridge body. Returns the typed payload or a one-line
 * reason for the 400. Unknown keys are dropped rather than refused so a newer
 * bridge can talk to an older Bot; `token` and `message` are the only two
 * fields whose absence makes the request meaningless.
 */
export function parseBridgePayload(body: unknown): BridgePayload | { error: string } {
  if (!isRecord(body)) {
    return { error: "body must be a JSON object" };
  }
  const { token, message } = body;
  if (typeof token !== "string" || token.length === 0) {
    return { error: "token is required" };
  }
  if (typeof message !== "string" || message.length === 0) {
    return { error: "message is required" };
  }

  const payload: BridgePayload = { message, token };

  for (const key of ["sender", "senderPhone", "senderName", "acct"] as const) {
    const parsed = optionalString(body, key);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    if (parsed.value !== undefined) {
      payload[key] = parsed.value;
    }
  }

  if (body.surface !== undefined && body.surface !== null) {
    if (body.surface !== "dm" && body.surface !== "group") {
      return { error: 'surface must be "dm" or "group"' };
    }
    payload.surface = body.surface;
  }

  if (body.context !== undefined && body.context !== null) {
    if (!Array.isArray(body.context) || !body.context.every((b) => typeof b === "string")) {
      return { error: "context must be an array of strings" };
    }
    payload.context = body.context as string[];
  }

  if (body.media !== undefined && body.media !== null) {
    if (!Array.isArray(body.media)) {
      return { error: "media must be an array" };
    }
    const media: BridgeMedia[] = [];
    for (const item of body.media) {
      if (!isRecord(item)) {
        return { error: "media entries must be objects" };
      }
      if (item.dataUrl !== undefined && typeof item.dataUrl !== "string") {
        return { error: "media.dataUrl must be a string" };
      }
      if (item.mime !== undefined && typeof item.mime !== "string") {
        return { error: "media.mime must be a string" };
      }
      media.push({
        ...(typeof item.mime === "string" ? { mime: item.mime } : {}),
        ...(typeof item.dataUrl === "string" ? { dataUrl: item.dataUrl } : {}),
      });
    }
    payload.media = media;
  }

  return payload;
}
