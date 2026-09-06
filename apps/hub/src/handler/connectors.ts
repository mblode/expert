import type { ClockClient } from "../service/clock.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { EVE_TURN_TIMEOUT_MS, runEveTurn } from "../service/turns.ts";
import { ComputerError, EVE_HUB_SECRET_HEADER } from "@computer/shared";
import type { Participant, Route } from "@computer/shared";
import type { BotRegistry } from "../service/bots.ts";
import type { ConnectorRecord, ConnectorRegistry } from "../service/connectors.ts";
import type { ConversationRegistry } from "../service/conversations.ts";
import type { InboundService } from "../service/inbound.ts";
import type { TurnService } from "../service/turns.ts";
import { firstHeader } from "./auth.ts";
import { TURN_HEADER, writeError } from "./router.ts";

const PREFIX = "/connectors/";
/**
 * Wider than the seat router's 1 MiB: the bridge attaches up to two 4 MB
 * images or a 3 MB PDF as base64 data URLs (4/3 growth), so a real photo is
 * ~5.5 MB on the wire. The bridge's own caps are the real limit; this only
 * stops a dump.
 */
const MAX_BODY = 12 * 1024 * 1024;
/** The header a connector presents. Never the seat token, never the Eve secret. */
const CONNECTOR_SECRET_HEADER = "x-connector-secret";

interface ConnectorIngressDeps {
  connectors: ConnectorRegistry;
  bots: BotRegistry;
  conversations: ConversationRegistry;
  turns: TurnService;
  inbound?: InboundService;
  paOwner?: { acct: string; jid: string };
  clock?: ClockClient;
  /** Where this Bot's Eve listens. Empty string means it has no Eve. */
  eveUrl: (botId: string, display: number) => string;
  /** Shared secret the Eve channel expects on loopback (`eve start`). */
  eveSecret?: string;
  /** Bring a sleeping Bot's Eve up before forwarding to it (`host/wake.ts`). */
  wake?: (botId: string, display: number) => Promise<void>;
  cors: Record<string, string>;
}

export function isConnectorPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * `/connectors/<id>/<rest>` → the Bot's Eve at `/eve/v1/<kind>/<rest>`.
 *
 * This is the door for anything that is not a seat: the WhatsApp bridge on
 * loopback today, a webhook or Slack later. It sits beside the seat-gated
 * Eve proxy rather than inside it because the two answer different questions:
 * the proxy asks "is this the owner", the ingress asks "is this the door it
 * claims to be". Both end at the same Eve with the same hub secret, so an Eve
 * channel file cannot tell them apart and does not need to.
 */
export async function handleConnectorIngress(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ConnectorIngressDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseConnectorPath(url.pathname);
    if (!parsed) {
      throw new ComputerError("VALIDATION", "connector path is /connectors/<id>/<path>");
    }
    if (req.method !== "POST") {
      throw new ComputerError("VALIDATION", "connectors take POST");
    }
    const secret = firstHeader(req.headers[CONNECTOR_SECRET_HEADER]);
    const record = deps.connectors.verify(parsed.id, secret);
    const target = `/eve/v1/${record.kind}/${parsed.rest}`;
    if (record.paths && record.paths.length > 0 && !record.paths.includes(target)) {
      throw new ComputerError("DENIED", `connector ${record.id} may not reach ${target}`);
    }
    let bot;
    try {
      bot = deps.bots.byId(record.bot);
    } catch {
      throw new ComputerError(
        "VALIDATION",
        `connector ${record.id} points at unknown bot ${record.bot}`,
      );
    }
    const base = deps.eveUrl(bot.id, bot.display).replace(/\/$/, "");
    if (!base) {
      throw daemonDown(bot.id);
    }
    // An event for a sleeping Bot wakes it. A webhook is the one caller with
    // nobody watching, so a cold start here is a second nobody sees.
    await deps.wake?.(bot.id, bot.display);
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) {
      throw new ComputerError("VALIDATION", `body over ${MAX_BODY} bytes`);
    }
    const body = await readBody(req);
    const inboundId = whatsappMessageId(record.kind, target, body);
    if (inboundId && deps.inbound) {
      const work = async () => {
        const bound = bindTurn(deps, record, bot.id, target, body);
        if (!bound) throw new ComputerError("VALIDATION", "invalid WhatsApp conversation");
        if (bound.human)
          deps.conversations.append(
            bound.conversationId,
            { kind: "human", ref: bound.speaker },
            { kind: "human", text: bound.human },
            { turn_id: bound.turnId },
          );
        return runEveTurn({
          url: `${base}${target}${url.search}`,
          secret: deps.eveSecret,
          body,
          bot: bot.id,
          conversation: bound.conversationId,
          turn: bound.turnId,
          turns: deps.turns,
          conversations: deps.conversations,
        });
      };
      const owner = deps.paOwner;
      const payload = JSON.parse(Buffer.from(body).toString("utf-8")) as Record<string, unknown>;
      const personal =
        owner &&
        record.id === `whatsapp-${owner.acct}` &&
        payload.acct === owner.acct &&
        payload.surface === "dm" &&
        payload.sender === owner.jid &&
        payload.token === owner.jid;
      if (personal && deps.clock) {
        await deps.inbound.accept(`${record.id}:${inboundId}`, body, owner, work, deps.clock);
        res.writeHead(202, {
          "content-type": "application/json",
          "cache-control": "no-store",
          ...deps.cors,
        });
        res.end(JSON.stringify({ accepted: true, reply: "" }));
        return;
      }
      const reply = await deps.inbound.execute(`${record.id}:${inboundId}`, body, work);
      res.writeHead(reply.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...deps.cors,
      });
      res.end(reply.body);
      return;
    }
    const bound = bindTurn(deps, record, bot.id, target, body);
    // What the person said, recorded before the Bot is asked anything. The
    // conversation was resolved and then left empty until now: it held the
    // route and the participants but never a word of the exchange, so a
    // WhatsApp thread was invisible to every client on purpose-built
    // plumbing. Best effort, like the binding above: a chat that cannot be
    // written to must not stop the message reaching the Bot.
    if (bound?.human) {
      try {
        deps.conversations.append(
          bound.conversationId,
          { kind: "human", ref: bound.speaker },
          { kind: "human", text: bound.human },
          { turn_id: bound.turnId },
        );
      } catch {
        // Recording is not the delivery path.
      }
    }

    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) {
        abort.abort();
      }
    });
    let upstream: Response;
    try {
      upstream = await fetch(`${base}${target}${url.search}`, {
        body,
        headers: {
          "content-type": firstHeader(req.headers["content-type"]) ?? "application/json",
          ...(deps.eveSecret ? { [EVE_HUB_SECRET_HEADER]: deps.eveSecret } : {}),
          ...(bound ? { [TURN_HEADER]: bound.turnId } : {}),
        },
        method: "POST",
        redirect: "manual",
        // The client going away or the turn deadline, whichever first.
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(EVE_TURN_TIMEOUT_MS)]),
      });
    } catch {
      throw daemonDown(bot.id);
    }
    res.writeHead(upstream.status, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
      ...deps.cors,
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    const stream = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
    stream.on("error", () => res.destroy());
    // Tee, do not buffer-then-forward: the reply reaches the bridge at the
    // same moment it always did, and the record is written from a copy once
    // the body is complete. `REPLY_CAPTURE_MAX` bounds what is held, because
    // this path is generic over connector kinds and only WhatsApp's reply is
    // small by construction.
    if (bound && upstream.ok) {
      recordReply(deps, bound, bot.id, stream);
    }
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      writeError(res, error);
    }
  }
}

/** Enough for any chat reply; a webhook that answers with a payload is not a message. */
const REPLY_CAPTURE_MAX = 64 * 1024;

/**
 * Write the Bot's answer into the conversation once the response is complete.
 *
 * The reply is the occurrence here, not a scratchpad leaking: `{ reply }` is
 * literally the text the bridge posts into the chat, so recording it is
 * recording what the human was told. `recordDelivery` is what keeps a turn
 * that already used `send_message` from being written twice.
 */
function recordReply(
  deps: ConnectorIngressDeps,
  bound: Bound,
  botId: string,
  stream: Readable,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  stream.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > REPLY_CAPTURE_MAX) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  stream.on("end", () => {
    if (over) {
      return;
    }
    let reply: unknown;
    try {
      ({ reply } = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as { reply?: unknown });
    } catch {
      return;
    }
    if (typeof reply !== "string" || !reply.trim()) {
      return;
    }
    try {
      // No-ops when the turn already spoke through `send_message`, which owns
      // the better record.
      deps.conversations.recordDelivery(
        bound.conversationId,
        { bot: botId, kind: "bot" },
        { images: [], kind: "text", text: reply },
        bound.turnId,
      );
    } catch {
      // Recording is not the delivery path.
    }
  });
}

/**
 * Resolve the inbound to a conversation and mint the turn token that binds
 * this Eve call to it.
 *
 * Best effort by design. A body that is not the shape this kind expects gets
 * no token and Eve answers exactly as it does today, including its own 400:
 * the ingress must not become a second validator of a payload it forwards
 * opaquely, and a missing token already means "the seat thread", which is the
 * behaviour that predates conversations.
 */
function bindTurn(
  deps: ConnectorIngressDeps,
  record: ConnectorRecord,
  botId: string,
  target: string,
  body: Uint8Array,
): Bound | undefined {
  const route = routeFor(record, target, body, botId);
  if (!route) {
    return undefined;
  }
  const conversation = deps.conversations.resolve(botId, route.route, route.participants);
  return {
    conversationId: conversation.id,
    human: route.human,
    speaker: route.speaker,
    turnId: deps.turns.mint({
      bot: botId,
      conversation_id: conversation.id,
      ...(route.route.kind === "whatsapp" &&
      deps.paOwner &&
      route.route.acct === deps.paOwner.acct &&
      route.route.jid === deps.paOwner.jid &&
      route.speaker === deps.paOwner.jid &&
      record.id === `whatsapp-${deps.paOwner.acct}`
        ? { owner: deps.paOwner }
        : {}),
    }).id,
  };
}

/** What the ingress needs after the route is known: where to write, and from whom. */
interface Bound {
  conversationId: string;
  /** The inbound text, so the record holds what was said and not only that it happened. */
  human?: string;
  /** The sender's ref, for the message's author. */
  speaker: string;
  turnId: string;
}

/** The bridge payload's two identifying fields. Anything else is not a route. */
interface WhatsAppInbound {
  token?: unknown;
  sender?: unknown;
  acct?: unknown;
  message?: unknown;
}

function routeFor(
  record: ConnectorRecord,
  target: string,
  body: Uint8Array,
  botId: string,
): { route: Route; participants: Participant[]; human?: string; speaker: string } | undefined {
  // One kind has a route today. A webhook has no chat to be a conversation
  // with, so it keeps forwarding untouched.
  if (record.kind !== "whatsapp" || target !== "/eve/v1/whatsapp/message") {
    return undefined;
  }
  let parsed: WhatsAppInbound;
  try {
    parsed = JSON.parse(Buffer.from(body).toString("utf-8")) as WhatsAppInbound;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const jid = typeof parsed.token === "string" ? parsed.token : "";
  if (!jid) {
    return undefined;
  }
  // An older bridge does not send `acct`. A connector record is one linked
  // number, so its id names the account when the payload does not, which
  // keeps the route stable rather than collapsing two numbers into one.
  const acct = typeof parsed.acct === "string" && parsed.acct ? parsed.acct : record.id;
  // In a DM the sender is the chat; in a group each message names one member
  // of many, so this is one speaker rather than the roster. `resolve` unions
  // it into the record, which is how a group thread accumulates its members.
  const ref = typeof parsed.sender === "string" && parsed.sender ? parsed.sender : jid;
  return {
    human: typeof parsed.message === "string" ? parsed.message : undefined,
    participants: [
      { bot: botId, kind: "bot" },
      { kind: "human", ref },
    ],
    route: { acct, jid, kind: "whatsapp" },
    speaker: ref,
  };
}

export function parseConnectorPath(pathname: string): { id: string; rest: string } | undefined {
  if (!pathname.startsWith(PREFIX)) {
    return undefined;
  }
  const tail = pathname.slice(PREFIX.length);
  const slash = tail.indexOf("/");
  if (slash <= 0 || slash === tail.length - 1) {
    return undefined;
  }
  const id = tail.slice(0, slash);
  const rest = tail.slice(slash + 1);
  if (rest.includes("..") || rest.startsWith("/")) {
    return undefined;
  }
  return { id, rest };
}

function daemonDown(botId: string): ComputerError {
  return new ComputerError(
    "DAEMON_DOWN",
    `the agent is not running for bot ${botId}: the guest starts it with eve start`,
  );
}

async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) {
      throw new ComputerError("VALIDATION", `body over ${MAX_BODY} bytes`);
    }
    chunks.push(c as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Older bridge traffic has no stable identity and keeps its existing path. */
function whatsappMessageId(kind: string, target: string, body: Uint8Array): string | undefined {
  if (kind !== "whatsapp" || target !== "/eve/v1/whatsapp/message") return undefined;
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf-8")) as {
      messageId?: unknown;
      token?: unknown;
    };
    return typeof value.messageId === "string" && value.messageId && typeof value.token === "string"
      ? JSON.stringify([value.token, value.messageId])
      : undefined;
  } catch {
    return undefined;
  }
}
