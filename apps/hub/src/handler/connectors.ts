import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ComputerError } from "@computer/shared";
import type { Participant, Route } from "@computer/shared";
import type { BotRegistry } from "../service/bots.ts";
import type { ConnectorRecord, ConnectorRegistry } from "../service/connectors.ts";
import type { ConversationRegistry } from "../service/conversations.ts";
import type { TurnService } from "../service/turns.ts";
import { EVE_HUB_SECRET_HEADER } from "../host/eve.ts";
import { firstHeader } from "./auth.ts";
import { TURN_HEADER, writeError } from "./router.ts";

const PREFIX = "/connectors/";
/**
 * Compatibility alias. The WhatsApp bridge deployed on both tenants posts to
 * `/channels/<id>/<rest>`, and a hub that only answered the new prefix would
 * cut it off the moment it deployed. Remove this, and the header alias below,
 * once Blode and Vibey are both running a bridge that sends the new names.
 */
const LEGACY_PREFIX = "/channels/";
/**
 * Wider than the seat router's 1 MiB: the bridge attaches up to two 4 MB
 * images or a 3 MB PDF as base64 data URLs (4/3 growth), so a real photo is
 * ~5.5 MB on the wire. The bridge's own caps are the real limit; this only
 * stops a dump.
 */
const MAX_BODY = 12 * 1024 * 1024;
/** The header a connector presents. Never the seat token, never the Eve secret. */
const CONNECTOR_SECRET_HEADER = "x-connector-secret";
/** Compatibility alias, retired with `LEGACY_PREFIX` above. */
const LEGACY_CONNECTOR_SECRET_HEADER = "x-channel-secret";

interface ConnectorIngressDeps {
  connectors: ConnectorRegistry;
  bots: BotRegistry;
  conversations: ConversationRegistry;
  turns: TurnService;
  /** Where this Bot's Eve listens. Empty string means it has no Eve. */
  eveUrl: (botId: string, display: number) => string;
  /** Shared secret the Eve channel expects on loopback (`eve start`). */
  eveSecret?: string;
  cors: Record<string, string>;
}

export function isConnectorPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX) || pathname.startsWith(LEGACY_PREFIX);
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
    // Either header opens the door; a bridge sends one or the other, never
    // both, so there is nothing to reconcile when the alias goes.
    const secret =
      firstHeader(req.headers[CONNECTOR_SECRET_HEADER]) ??
      firstHeader(req.headers[LEGACY_CONNECTOR_SECRET_HEADER]);
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
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY) {
      throw new ComputerError("VALIDATION", `body over ${MAX_BODY} bytes`);
    }
    const body = await readBody(req);
    const turn = bindTurn(deps, record, bot.id, target, body);

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
          ...(turn ? { [TURN_HEADER]: turn } : {}),
        },
        method: "POST",
        redirect: "manual",
        signal: abort.signal,
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
    stream.pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      writeError(res, error);
    }
  }
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
): string | undefined {
  const route = routeFor(record, target, body, botId);
  if (!route) {
    return undefined;
  }
  const conversation = deps.conversations.resolve(botId, route.route, route.participants);
  return deps.turns.mint({ bot: botId, conversation_id: conversation.id }).id;
}

/** The bridge payload's two identifying fields. Anything else is not a route. */
interface WhatsAppInbound {
  token?: unknown;
  sender?: unknown;
  acct?: unknown;
}

function routeFor(
  record: ConnectorRecord,
  target: string,
  body: Uint8Array,
  botId: string,
): { route: Route; participants: Participant[] } | undefined {
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
  // In a DM the sender is the chat; in a group the first message names one
  // member of many. The participant list is what the record was created
  // with and is never rewritten from a later inbound, see `resolve`.
  const ref = typeof parsed.sender === "string" && parsed.sender ? parsed.sender : jid;
  return {
    participants: [
      { bot: botId, kind: "bot" },
      { kind: "human", ref },
    ],
    route: { acct, jid, kind: "whatsapp" },
  };
}

export function parseConnectorPath(pathname: string): { id: string; rest: string } | undefined {
  const prefix = pathname.startsWith(PREFIX)
    ? PREFIX
    : pathname.startsWith(LEGACY_PREFIX)
      ? LEGACY_PREFIX
      : undefined;
  if (prefix === undefined) {
    return undefined;
  }
  const tail = pathname.slice(prefix.length);
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
