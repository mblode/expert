import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { ComputerError } from "@computer/shared";
import type { BotRegistry } from "../service/bots.ts";
import type { ChannelRegistry } from "../service/channels.ts";
import { EVE_HUB_SECRET_HEADER } from "../host/eve.ts";
import { writeError } from "./router.ts";

const PREFIX = "/channels/";
/**
 * Wider than the seat router's 1 MiB: the bridge attaches up to two 4 MB
 * images or a 3 MB PDF as base64 data URLs (4/3 growth), so a real photo is
 * ~5.5 MB on the wire. The bridge's own caps are the real limit; this only
 * stops a dump.
 */
const MAX_BODY = 12 * 1024 * 1024;
/** The header a channel presents. Never the seat token, never the Eve secret. */
export const CHANNEL_SECRET_HEADER = "x-channel-secret";

export interface ChannelIngressDeps {
  channels: ChannelRegistry;
  bots: BotRegistry;
  /** Where this Bot's Eve listens. Empty string means it has no Eve. */
  eveUrl: (botId: string, display: number) => string;
  /** Shared secret the Eve channel expects on loopback (`eve start`). */
  eveSecret?: string;
  cors: Record<string, string>;
}

export function isChannelPath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * `/channels/<id>/<rest>` → the Bot's Eve at `/eve/v1/<kind>/<rest>`.
 *
 * This is the door for anything that is not a seat: the WhatsApp bridge on
 * loopback today, a webhook or Slack later. It sits beside the seat-gated
 * Eve proxy rather than inside it because the two answer different questions:
 * the proxy asks "is this the owner", the ingress asks "is this the door it
 * claims to be". Both end at the same Eve with the same hub secret, so an Eve
 * channel file cannot tell them apart and does not need to.
 */
export async function handleChannelIngress(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ChannelIngressDeps,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const parsed = parseChannelPath(url.pathname);
    if (!parsed) {
      throw new ComputerError("VALIDATION", "channel path is /channels/<id>/<path>");
    }
    if (req.method !== "POST") {
      throw new ComputerError("VALIDATION", "channels take POST");
    }
    const secret = firstHeader(req.headers[CHANNEL_SECRET_HEADER]);
    const record = deps.channels.verify(parsed.id, secret);
    const target = `/eve/v1/${record.kind}/${parsed.rest}`;
    if (record.paths && record.paths.length > 0 && !record.paths.includes(target)) {
      throw new ComputerError("DENIED", `channel ${record.id} may not reach ${target}`);
    }
    let bot;
    try {
      bot = deps.bots.byId(record.bot);
    } catch {
      throw new ComputerError(
        "VALIDATION",
        `channel ${record.id} points at unknown bot ${record.bot}`,
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

export function parseChannelPath(pathname: string): { id: string; rest: string } | undefined {
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

function firstHeader(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
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
