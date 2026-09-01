import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { AuthRegistry } from "./auth.ts";
import { tokenFromRequest } from "./auth.ts";
import { writeJson } from "./router.ts";

/** Eve serves her own protocol on loopback; `npm run up` starts her here. */
export const DEFAULT_EVE_URL = "http://127.0.0.1:2000";

const PREFIX = "/eve/v1/";

export type EveProxyDeps = {
  auth: AuthRegistry;
  /** Empty means Eve is not configured — every call is DAEMON_DOWN. */
  eveUrl?: string;
  /** CORS headers to echo onto the proxied response (app.ts owns the policy). */
  cors: Record<string, string>;
};

export function isEvePath(pathname: string): boolean {
  return pathname.startsWith(PREFIX);
}

/**
 * One origin, one credential: the phone and the web client speak Eve's own
 * protocol through the paired hub instead of a second server with a second
 * auth scheme. Pixels and Eve are gated the same way — a seat token.
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
  const base = deps.eveUrl?.replace(/\/$/, "");
  if (!base) {
    daemonDown(res);
    return;
  }

  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  // The seat token means nothing to Eve; don't leak it into her logs either.
  url.searchParams.delete("token");
  const target = `${base}${url.pathname}${url.search}`;

  // Client hangs up (tab closed, phone locked) → abort upstream, or the NDJSON
  // stream stays open for the life of the process. The response is the signal:
  // `req` closes as soon as its body is read, which is not a disconnect.
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method ?? "GET",
      // Authorization is stripped: Eve's localDev auth trusts loopback.
      headers: forwardHeaders(req),
      body: await requestBody(req),
      signal: abort.signal,
      redirect: "manual",
    });
  } catch {
    if (!res.headersSent) daemonDown(res);
    return;
  }

  // Eve's own x-eve-* headers are part of its protocol — x-eve-stream-tail-index
  // is what a client needs for a bounded catch-up read, and dropping it makes
  // eve/client refuse to replay a session. Forward them, and expose them to
  // browsers, which cannot read a response header unless it is listed.
  const eveHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (name.toLowerCase().startsWith("x-eve-")) eveHeaders[name] = value;
  });
  res.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
    // GET /eve/v1/session/:id/stream is long-lived NDJSON: nothing may buffer it.
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

function daemonDown(res: ServerResponse): void {
  writeJson(res, 503, {
    error: { code: "DAEMON_DOWN", message: "the agent is not running — start it with `npm run eve`" },
  });
}

/** Method, body, and content type travel; hop-by-hop and credentials do not. */
function forwardHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["content-type", "accept"]) {
    const v = req.headers[name];
    const first = Array.isArray(v) ? v[0] : v;
    if (first) out[name] = first;
  }
  return out;
}

async function requestBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer> | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  // fetch wants a non-shared view; Buffer.concat is typed over ArrayBufferLike.
  return chunks.length ? new Uint8Array(Buffer.concat(chunks)) : undefined;
}
