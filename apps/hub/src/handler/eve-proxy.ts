import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AuthRegistry } from "./auth.ts";
import { firstHeader, tokenFromRequest } from "./auth.ts";
import { writeJson } from "./router.ts";
import type { BotRegistry } from "../service/bots.ts";
import { EVE_HUB_SECRET_HEADER, pickEveBotId } from "../host/eve.ts";

const PREFIX = "/eve/v1/";

interface EveProxyDeps {
  auth: AuthRegistry;
  bots: BotRegistry;
  /** Where this Bot's Eve listens. Empty string means it has no Eve. */
  eveUrl: (botId: string, display: number) => string;
  /** Shared secret the Eve channel expects on loopback (`eve start`). */
  eveSecret?: string;
  /** Bring a sleeping Bot's Eve up before forwarding to it (`host/wake.ts`). */
  wake?: (botId: string, display: number) => Promise<void>;
  cors: Record<string, string>;
}

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
  // The thread is the owner's. A guest seat took the mouse for a few minutes,
  // it did not get to read or steer the conversation.
  if (!deps.auth.isOwner(tokenFromRequest(req))) {
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

  const base = deps.eveUrl(bot.id, bot.display).replace(/\/$/, "");
  if (!base) {
    daemonDown(res, bot.id);
    return;
  }

  // A Bot with nothing to do has no process. Opening its chat is what brings
  // it back, and this waits for it: about a second on the guest, against a
  // `DAEMON_DOWN` that would look like a broken computer.
  await deps.wake?.(bot.id, bot.display);

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  url.searchParams.delete("token");
  url.searchParams.delete("bot");
  const target = `${base}${url.pathname}${url.search}`;

  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) {
      abort.abort();
    }
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      body: await requestBody(req),
      headers: forwardHeaders(req, deps.eveSecret),
      method: req.method ?? "GET",
      redirect: "manual",
      signal: abort.signal,
    });
  } catch {
    if (!res.headersSent) {
      daemonDown(res, bot.id);
    }
    return;
  }

  const eveHeaders: Record<string, string> = {};
  for (const [name, value] of upstream.headers) {
    if (name.toLowerCase().startsWith("x-eve-")) {
      eveHeaders[name] = value;
    }
  }
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
      message: `the agent is not running${who}: the guest starts it with eve start`,
    },
  });
}

/** Method, body, and content type travel; the seat token does not. The hub secret does. */
function forwardHeaders(req: IncomingMessage, eveSecret?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "accept"]) {
    const first = firstHeader(req.headers[name]);
    if (first) {
      out[name] = first;
    }
  }
  if (eveSecret) {
    out[EVE_HUB_SECRET_HEADER] = eveSecret;
  }
  return out;
}

async function requestBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(c as Buffer);
  }
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}
