import { createConnection, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import { MAX_DISPLAYS, PRIMARY_DISPLAY } from "@computer/shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuthRegistry } from "./handler/auth.ts";
import { tokenFromRequest } from "./handler/auth.ts";

/**
 * websockify: noVNC talks RFC6455; x11vnc talks raw RFB on 5900+N
 * (localhost, view-only). `?display=N` selects the window (default primary).
 * Pixel or seat token required (query `token` or Authorization).
 * Inside the guest, noVNC also listens on 6080 / 6081+ (Grok ports).
 *
 * Queue client bytes until the RFB TCP socket is connected. noVNC replies
 * to `RFB 003.008` immediately; a write before `connect` can drop that
 * version string and the handshake never leaves the banner.
 */
export function attachVncProxy(
  wss: WebSocketServer,
  opts: {
    host: string;
    basePort: number;
    auth: AuthRegistry;
    hasDisplay: (display: number) => boolean;
  },
): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    if (!opts.auth.canViewPixels(tokenFromRequest(req))) {
      ws.close(4401, "unauthenticated");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/websockify" && url.pathname !== "/vnc/websockify") {
      ws.close();
      return;
    }
    const display = parseDisplayParam(url.searchParams.get("display"));
    if (display === null || !opts.hasDisplay(display)) {
      ws.close(4404, "unknown display");
      return;
    }
    const sock = createConnection({ host: opts.host, port: opts.basePort + display });
    bridgeRfb(ws, sock);
  });
}

/** Pipe WS ↔ TCP, holding client frames until the RFB port accepts. */
export function bridgeRfb(ws: WebSocket, sock: Socket): void {
  const pending: Buffer[] = [];
  let ready = false;

  const toRfb = (chunk: Buffer) => {
    if (ready) sock.write(chunk);
    else pending.push(chunk);
  };

  sock.on("connect", () => {
    ready = true;
    for (const chunk of pending) sock.write(chunk);
    pending.length = 0;
  });
  sock.on("error", () => ws.close());
  sock.on("data", (d) => {
    if (ws.readyState === ws.OPEN) ws.send(d, { binary: true });
  });
  sock.on("close", () => ws.close());
  ws.on("message", (d) => {
    // ws delivers Buffer | ArrayBuffer | Buffer[]; a fragmented frame arrives
    // as the array and must be joined, not passed to Buffer.from().
    if (Buffer.isBuffer(d)) toRfb(d);
    else if (Array.isArray(d)) toRfb(Buffer.concat(d));
    else toRfb(Buffer.from(d));
  });
  ws.on("close", () => sock.destroy());
}

function parseDisplayParam(v: string | null): number | null {
  if (v === null || v === "") return PRIMARY_DISPLAY;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPLAYS) return null;
  return n;
}

export function verifyVncUpgrade(auth: AuthRegistry, req: IncomingMessage): boolean {
  return auth.canViewPixels(tokenFromRequest(req));
}
