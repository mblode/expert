import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import { MAX_DISPLAYS, PRIMARY_DISPLAY } from "@computer/shared";
import { WebSocketServer, type WebSocket } from "ws";
import type { AuthRegistry } from "./handler/auth.ts";
import { tokenFromRequest } from "./handler/auth.ts";

/**
 * websockify: noVNC talks RFC6455; TigerVNC talks raw RFB on 5900+N —
 * one port per window index, `?display=N` selects it (default primary).
 * Seat token required (query `token` or Authorization). Hub still binds
 * 127.0.0.1.
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
    if (!opts.auth.hasSeatToken(tokenFromRequest(req))) {
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
    sock.on("error", () => ws.close());
    sock.on("data", (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    sock.on("close", () => ws.close());
    ws.on("message", (d) => {
      if (Buffer.isBuffer(d)) sock.write(d);
      else if (d instanceof ArrayBuffer) sock.write(Buffer.from(d));
      else sock.write(Buffer.from(d as Uint8Array));
    });
    ws.on("close", () => sock.destroy());
  });
}

function parseDisplayParam(v: string | null): number | null {
  if (v === null || v === "") return PRIMARY_DISPLAY;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DISPLAYS) return null;
  return n;
}

export function verifyVncUpgrade(auth: AuthRegistry, req: IncomingMessage): boolean {
  return auth.hasSeatToken(tokenFromRequest(req));
}
