import type { ChannelSource } from "eve/channels";
import { defineChannel, POST } from "eve/channels";
import { createUnauthorizedResponse } from "eve/channels/auth";
import { EVE_HUB_SECRET_HEADER } from "@computer/shared";
import { eveHubSecretFromEnv, eveHubSecretMatches, secretFromEnv } from "../auth.ts";
import { TURN_HEADER } from "../hub.ts";
import { outboundReply } from "../format-reply.ts";
import { parseBridgePayload } from "./bridge-protocol.ts";
import { neutraliseFence } from "./fence.ts";
import type { BridgeMedia, BridgePayload } from "./bridge-protocol.ts";

/**
 * WhatsApp channel, generic over the Bot it is mounted on.
 *
 * WhatsApp groups are not reachable over the official Business API, so this
 * channel never talks to WhatsApp. A Baileys bridge logs into a real account,
 * listens, and POSTs each message here; the agent runs and the reply goes back
 * synchronously in the response so the bridge can post it into the chat.
 *
 * Two doors, one route. In production the bridge posts to the hub's connector
 * ingress on loopback, and the hub forwards here with `x-computer-eve-secret`,
 * the same header it uses for the `/eve/v1` proxy. `x-bridge-secret` is the
 * direct path: an eve TUI, a Vercel fallback, or a bridge with no hub in front.
 * Enable the channel on a Bot by re-exporting this module from
 * `agent/channels/whatsapp.ts`; the file stem is the channel id.
 */

/** Direct-path header: the bridge and Eve share `WHATSAPP_BRIDGE_SECRET`. */
export const BRIDGE_SECRET_HEADER = "x-bridge-secret";

/** The direct door's secret, read through the one rule `secretFromEnv` owns. */
const bridgeSecretFromEnv = (env: NodeJS.ProcessEnv): string | undefined =>
  secretFromEnv("WHATSAPP_BRIDGE_SECRET", env);

/**
 * What the Bot says when a turn completes with no text in it.
 *
 * The turn succeeded; there is simply nothing in it. The reproducible case is a
 * hard jailbreak probe, where the model declines by emitting nothing rather
 * than by writing a refusal. Silence is the worst available answer there: the
 * bridge only sends when the reply is truthy, so an empty string means typing
 * stops and no message ever arrives, and in a group that pokes the bot for
 * sport that reads as "we broke it" at exactly the moment a flat no belonged on
 * the record. Deliberately neutral about the cause and deliberately not a
 * refusal line: the channel cannot tell a model that declined from a transient
 * blank, so it says the one thing true of both.
 */
export const EMPTY_REPLY_FALLBACK = "nothing came out of that one, have another go";

/** Which secret let the request in. Recorded on the session so tools can tell. */
export type BridgeAuthPath = "hub" | "bridge";

/**
 * The auth decision, kept pure so it is testable without a request. Either
 * header is enough on its own; the hub path wins when both are present so the
 * session records the door production traffic actually uses. Both comparisons
 * are constant-time through `eveHubSecretMatches`. An unset env disables that
 * door rather than accepting anything, and a set-but-empty env is the same as
 * unset (a blank `WHATSAPP_BRIDGE_SECRET=` in a `.env` must not open the route).
 */
export function bridgeRequestAuthorised(
  headers: Headers,
  env: NodeJS.ProcessEnv = process.env,
): BridgeAuthPath | null {
  if (eveHubSecretMatches(headers.get(EVE_HUB_SECRET_HEADER), eveHubSecretFromEnv(env))) {
    return "hub";
  }
  if (eveHubSecretMatches(headers.get(BRIDGE_SECRET_HEADER), bridgeSecretFromEnv(env))) {
    return "bridge";
  }
  return null;
}

/** True when at least one door has a secret behind it. */
export function bridgeAuthConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(eveHubSecretFromEnv(env) ?? bridgeSecretFromEnv(env));
}

/**
 * The rule every WhatsApp reply carries, on both surfaces. It lives here and
 * not only in instructions.md because a Bot that swaps its instructions must
 * keep it: a hello.expert link is the only way a human takes the mouse or
 * consents to a plugin, and it is never how an edit happens. The plumbing
 * words (tokens, VNC) are named so the model knows what not to say.
 */
const RESPONSE_RULE =
  "Reply in plain text suitable for WhatsApp. Keep it concise, avoid Markdown tables/headings/code fences, and ask at most one short follow-up question. When they ask you to change how you work, distinguish saved files from active behavior. Only claim a memory, instruction, skill, routine or plugin is active after the runtime confirms it; otherwise state what remains. Use authenticated hello.expert links for computer takeover, coding conversations and plugin setup. Never include credentials or VNC URLs.";

const buildContextBlock = (payload: BridgePayload): string => {
  // Every value below is interpolated into the block the model is told to
  // trust, and `senderName` is a WhatsApp profile name its owner picked, so
  // each one goes through `contextValue` first. See that function.
  const { surface } = payload;
  const token = contextValue(payload.token) ?? "";
  const senderName = contextValue(payload.senderName);
  const sender = contextValue(payload.sender);
  const acct = contextValue(payload.acct);
  const messageId = contextValue(payload.messageId);
  const lines =
    surface === "dm"
      ? [
          "surface: whatsapp_dm",
          `response_instructions: This is a 1:1 DM. ${RESPONSE_RULE} No concierge or FAQ framing, do not act like a help desk.`,
          `chat_jid: ${token}`,
        ]
      : [
          "surface: whatsapp_group",
          `response_instructions: ${RESPONSE_RULE}`,
          `group_jid: ${token}`,
        ];
  return [
    "<whatsapp_context>",
    ...lines,
    ...(acct ? [`account: ${acct}`] : []),
    ...(senderName ? [`sender_name: ${senderName}`] : []),
    ...(sender ? [`sender_jid: ${sender}`] : []),
    // The handle for quoting or reacting to this message on the send envelope.
    // Absent on an older bridge, so a tool must treat it as optional.
    ...(messageId ? [`message_id: ${messageId}`] : []),
    "</whatsapp_context>",
  ].join("\n");
};

/**
 * The context strings eve appends as user messages ahead of the turn: the
 * channel's own block first, then whatever the bridge attached (recent
 * messages, shared links, the conversation tail). The bridge blocks are
 * member-supplied content, so each is fenced as untrusted: data for the agent
 * to read, never instructions to follow. Blank blocks are dropped so an empty
 * fence never reaches the model.
 */
export const buildContext = (payload: BridgePayload): string[] => {
  const context = [buildContextBlock(payload)];
  for (const block of payload.context ?? []) {
    if (block.trim()) {
      context.push(`<untrusted_context>\n${neutraliseFence(block)}\n</untrusted_context>`);
    }
  }
  return context;
};

/**
 * One value on a `key: value` line of the channel's own context block:
 * fence-escaped, flattened to a single line, or undefined when nothing
 * survives. The newlines go because a second line here is a field the bridge
 * never sent, and a reader (model or human) cannot tell the two apart.
 */
const contextValue = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return neutraliseFence(value.replaceAll(/[\r\n]+/gu, " ")).trim() || undefined;
};

/**
 * The session auth for one inbound message, kept pure so the header round
 * trip is testable without a request.
 *
 * `groupJid` is the chat JID on both surfaces (the name is historical; in a
 * DM it is the DM JID). Tools and memory key on it, so it must be the real
 * chat and not the per-message continuation token.
 *
 * `turn` is the hub's binding for this turn, minted by the connector ingress
 * and bound there to a conversation and to this Bot. It rides auth
 * attributes rather than the prompt or a tool argument because that is the
 * one place the model cannot reach: `send_message` reads it back off
 * `ctx.session.auth.current` and hands it to the hub, so the hub decides
 * which conversation the reply lands in. Absent (the direct bridge path, an
 * eve TUI) means the Bot's seat thread, which is the behaviour that predates
 * conversations.
 *
 * `messageId` rides along for the same reason the context block shows it: it
 * is what `whatsapp_send` quotes or reacts to, and taking it from here rather
 * than from the model's copy of that block means an id the bridge issued is
 * the only id a send can carry.
 */
export const buildAuth = (
  payload: BridgePayload,
  via: BridgeAuthPath,
  turn: string | undefined,
) => {
  const { token, sender, senderName, senderPhone, acct, messageId } = payload;
  return {
    attributes: {
      groupJid: token,
      via,
      ...(acct ? { acct } : {}),
      ...(messageId ? { messageId } : {}),
      ...(senderName ? { senderName } : {}),
      ...(senderPhone ? { senderPhone } : {}),
      ...(turn ? { turn } : {}),
    },
    authenticator: "whatsapp-bridge",
    principalId: sender ?? token,
    principalType: "user",
  } as const;
};

/** What `from(address).send` accepts: a string or the AI SDK's user content parts. */
export type ChannelMessage = Parameters<ChannelSource["send"]>[0];

/** Two images bounds token cost; the bridge already downscales each one. */
export const MAX_IMAGES_PER_MESSAGE = 2;

/**
 * With images attached, a multimodal user turn (text plus file parts) so the
 * model can see them; otherwise plain text. Entries with no `dataUrl` are
 * skipped rather than refused: an old bridge sends `{ mime }` alone for media
 * it could not download, and that must not cost the message.
 */
export const buildUserMessage = (
  message: string,
  media: BridgeMedia[] | undefined,
): ChannelMessage => {
  const images = (media ?? [])
    .filter((m): m is BridgeMedia & { dataUrl: string } => typeof m.dataUrl === "string")
    .slice(0, MAX_IMAGES_PER_MESSAGE);
  if (images.length === 0) {
    return message;
  }
  return [
    { text: message, type: "text" },
    ...images.map((m) => ({
      data: m.dataUrl,
      mediaType: m.mime || "image/jpeg",
      type: "file" as const,
    })),
  ];
};

/** The slice of eve's stream events this channel reads. */
export interface ReplyStreamEvent {
  type: string;
  data?: { message?: string | null };
}

/**
 * Reads the session's event stream until the turn ends and returns the last
 * completed assistant message. The model emits interim narration before each
 * tool call ("Let me look..."); only the final message is the answer to send.
 * The stream is a live tail that never closes on its own, so the loop breaks
 * on the terminal turn event rather than waiting for `done`.
 */
export const drainStream = async (stream: ReadableStream<ReplyStreamEvent>): Promise<string> => {
  const reader = stream.getReader();
  let finalMessage = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value.type === "message.completed" && value.data?.message) {
        finalMessage = value.data.message;
      }
      if (value.type === "turn.completed" || value.type === "turn.failed") {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return finalMessage;
};

export default defineChannel({
  routes: [
    POST("/eve/v1/whatsapp/message", async (req, { from, resolveSession }) => {
      if (!bridgeAuthConfigured()) {
        return Response.json(
          { error: "neither COMPUTER_EVE_SECRET nor WHATSAPP_BRIDGE_SECRET is configured" },
          { status: 503 },
        );
      }
      const via = bridgeRequestAuthorised(req.headers);
      if (!via) {
        return createUnauthorizedResponse({ message: "bad or missing bridge secret" });
      }

      let body: unknown;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      const parsed = parseBridgePayload(body);
      if ("error" in parsed) {
        return Response.json({ error: parsed.error }, { status: 400 });
      }
      const { token, message, media } = parsed;
      const auth = buildAuth(parsed, via, req.headers.get(TURN_HEADER) ?? undefined);

      // Serialize the snapshot/send/read sequence. A queued concurrent request
      // must not mistake the previous request's terminal event for its own.
      const continuationToken = JSON.stringify([parsed.acct ?? "default", token]);
      const finalMessage = await serialTurn(continuationToken, async () => {
        const previous = await resolveSession(continuationToken);
        const startIndex = previous ? await previous.getStreamTailIndex() : 0;
        const session = await from(continuationToken).send(buildUserMessage(message, media), {
          auth,
          context: buildContext(parsed),
        });
        const stream = await session.getEventStream({ startIndex });
        return drainStream(stream as unknown as ReadableStream<ReplyStreamEvent>);
      });

      // Deterministic guardrail: the model drifts toward em dashes and Markdown
      // emphasis that WhatsApp renders wrong, so normalise on the way out, then
      // strip any leaked secret or credential query param. See outboundReply.
      const reply = outboundReply(finalMessage);

      // The bridge only sends when the reply is truthy, so an empty string is
      // silence on the phone: typing stops and no message ever arrives.
      return Response.json({ reply: reply || EMPTY_REPLY_FALLBACK });
    }),
  ],
  // Group traffic arrives in bursts. The default `steer` would cancel a running
  // turn when the next message lands, and a WhatsApp reply that never arrives
  // reads as a crash; queue keeps every message answered in order.
  turnPolicy: "queue",
});

const pendingTurns = new Map<string, Promise<void>>();

/** One cursor belongs to one send. Different chats continue independently. */
export async function serialTurn<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = pendingTurns.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pendingTurns.set(key, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (pendingTurns.get(key) === current) pendingTurns.delete(key);
  }
}
