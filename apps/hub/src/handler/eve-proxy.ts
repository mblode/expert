import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AuthRegistry } from "./auth.ts";
import { tokenFromRequest } from "./auth.ts";
import { writeJson } from "./router.ts";
import type { BotRegistry } from "../service/bots.ts";
import {
  EVE_BOT_HEADER,
  EVE_HUB_SECRET_HEADER,
  eveUrlForDisplay,
  pickEveBotId,
} from "../host/eve.ts";

const PREFIX = "/eve/v1/";

export type EveProxyDeps = {
  auth: AuthRegistry;
  bots: BotRegistry;
  /**
   * Per-bot Eve URLs. Missing id → derive from that Bot's display
   * (`127.0.0.1:2000+(display-1)`). Empty string means this Bot has no Eve.
   */
  eveUrls?: Record<string, string>;
  /** Shared secret the Eve channel expects on loopback (`eve start`). */
  eveSecret?: string;
  cors: Record<string, string>;
};

export function isEvePath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * One origin, one credential: the phone and the web client speak Eve's own
 * protocol through the paired hub. The seat token picks a human; the Bot
 * (header / `?bot=` / primary) picks which Eve process owns that screen.
 */
export async function handleEveProxy(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EveProxyDeps,
): Promise<void> {
  if (!deps.auth.hasSeatToken(tokenFromRequest(req))) {
    writeJson(res, 401, { error: { code: "UNAUTHENTICATED", message: "seat token required" } });
    return;
  }

  const botId = pickEveBotId(req, deps.bots.primary().id);
  let bot;
  try {
    bot = deps.bots.byId(botId);
  } catch {
    writeJson(res, 404, { error: { code: "VALIDATION", message: `unknown bot ${botId}` } });
    return;
  }

  const mapped = deps.eveUrls?.[bot.id];
  const base = (mapped !== undefined ? mapped : eveUrlForDisplay(bot.display)).replace(/\/$/, "");
  if (!base) {
    daemonDown(res, bot.id);
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  url.searchParams.delete("token");
  url.searchParams.delete("bot");
  const target = `${base}${url.pathname}${url.search}`;

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method ?? "GET",
      headers: forwardHeaders(req, deps.eveSecret),
      body: await requestBody(req),
      signal: abort.signal,
      redirect: "manual",
    });
  } catch {
    if (!res.headersSent) daemonDown(res, bot.id);
    return;
  }

  const eveHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-eve-")) eveHeaders[name] = value;
  });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no",
    ...eveHeaders,
    ...deps.cors,
    "access-control-expose-headers": Object.keys(eveHeaders).join(", ") || "x-eve-session-id",
  });
  res.flushHeaders();
  if (!upstream.body) {
    res.end();
    return;
  }
  const body = Readable.fromWeb(upstream.body as unknown as WebReadableStream<Uint8Array>);
  body.on("error", () => res.destroy());
  body.pipe(res);
}

function daemonDown(res: ServerResponse, botId?: string): void {
  const who = botId ? ` for bot ${botId}` : "";
  writeJson(res, 503, {
    error: {
      code: "DAEMON_DOWN",
      message: `the agent is not running${who} — the guest starts it with eve start`,
    },
  });
}

/** Method, body, and content type travel; the seat token does not. The hub secret does. */
function forwardHeaders(req: IncomingMessage, eveSecret?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "accept"]) {
    const v = req.headers[name];
    const first = Array.isArray(v) ? v[0] : v;
    if (first) out[name] = first;
  }
  if (eveSecret) out[EVE_HUB_SECRET_HEADER] = eveSecret;
  return out;
}

async function requestBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}

export { EVE_BOT_HEADER, EVE_HUB_SECRET_HEADER };
