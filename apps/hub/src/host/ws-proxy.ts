/**
 * Raw HTTP Upgrade tunnel. The Fly edge cannot `fetch()` a WebSocket —
 * it must splice the client socket onto the guest hub's :8080 over 6PN
 * so noVNC `/websockify` becomes a TCP stream of pixels.
 */
import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

export const DEFAULT_GUEST_PORT = 8080;
export const DEFAULT_ACTIVITY_INTERVAL_MS = 30_000;

export function isUpgradeRequest(req: { headers: { upgrade?: string | string[] } }): boolean {
  const raw = req.headers.upgrade;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (value ?? "").toLowerCase() === "websocket";
}

export function guestHttpUrl(privateIp: string, pathWithQuery: string, port = DEFAULT_GUEST_PORT): string {
  const host = privateIp.includes(":") ? `[${privateIp}]` : privateIp;
  return `http://${host}:${port}${pathWithQuery}`;
}

export function guestConnectTarget(
  privateIp: string,
  port = DEFAULT_GUEST_PORT,
): { host: string; port: number; family: 4 | 6 } {
  return {
    host: privateIp,
    port,
    family: privateIp.includes(":") ? 6 : 4,
  };
}

export function buildUpgradePreamble(
  req: Pick<IncomingMessage, "method" | "url" | "headers">,
  privateIp: string,
  port = DEFAULT_GUEST_PORT,
): Buffer {
  const path = req.url && req.url.length > 0 ? req.url : "/";
  const host = privateIp.includes(":") ? `[${privateIp}]:${port}` : `${privateIp}:${port}`;
  const lines = [`${req.method ?? "GET"} ${path} HTTP/1.1`, `Host: ${host}`];
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (key.toLowerCase() === "host") continue;
    const v = Array.isArray(value) ? value.join(", ") : value;
    lines.push(`${key}: ${v}`);
  }
  if (!headerHas(req.headers, "connection")) lines.push("Connection: Upgrade");
  if (!headerHas(req.headers, "upgrade")) lines.push("Upgrade: websocket");
  lines.push("", "");
  return Buffer.from(lines.join("\r\n"));
}

function headerHas(headers: IncomingMessage["headers"], name: string): boolean {
  const v = headers[name];
  return v !== undefined && v !== "";
}

export function throttle(fn: () => void, minIntervalMs: number, clock: () => number = Date.now): () => void {
  let last = 0;
  return () => {
    const now = clock();
    if (now - last < minIntervalMs) return;
    last = now;
    fn();
  };
}

export type ProxyWebSocketOpts = {
  port?: number;
  timeoutMs?: number;
  onActivity?: () => void;
};

/**
 * Replay the Upgrade request onto the guest and pipe both directions.
 * `head` is the bytes Node already consumed past the header block.
 */
export function proxyWebSocket(
  req: IncomingMessage,
  client: Duplex,
  head: Buffer,
  privateIp: string,
  opts: ProxyWebSocketOpts = {},
): Promise<void> {
  const port = opts.port ?? DEFAULT_GUEST_PORT;
  const target = guestConnectTarget(privateIp, port);
  return new Promise((resolve, reject) => {
    const upstream = createConnection({
      host: target.host,
      port: target.port,
      family: target.family,
    });
    let settled = false;
    let connected = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      upstream.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("guest websocket connect timeout")), opts.timeoutMs ?? 15_000);
    const onEarlyError = (err: Error) => finish(connected ? undefined : err);
    upstream.once("error", onEarlyError);
    client.once("error", onEarlyError);
    upstream.once("connect", () => {
      connected = true;
      clearTimeout(timer);
      try {
        upstream.write(buildUpgradePreamble(req, privateIp, port));
        if (head.length) upstream.write(head);
      } catch (err) {
        finish(err instanceof Error ? err : new Error("upgrade write"));
        return;
      }
      const bump = () => opts.onActivity?.();
      client.on("data", bump);
      upstream.on("data", bump);
      upstream.pipe(client);
      client.pipe(upstream);
      client.once("close", () => finish());
      upstream.once("close", () => finish());
    });
  });
}
