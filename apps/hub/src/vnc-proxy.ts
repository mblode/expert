import { createConnection } from "node:net";
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
    const token = tokenFromRequest(req);
    if (!opts.auth.canViewPixels(token)) {
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
    // A pixel grant is minted for one screen; a seat token may view any.
    const grant = opts.auth.pixels.lookup(token);
    if (grant && grant.display !== display) {
      ws.close(4403, "token is for another display");
      return;
    }
    const sock = createConnection({ host: opts.host, port: opts.basePort + display });
    sock.on("error", () => ws.close());
    sock.on("data", (d) => {
      if (ws.readyState === ws.OPEN) ws.send(d);
    });
    sock.on("close", () => ws.close());
    ws.on("message", (d) => {
      // ws delivers Buffer | ArrayBuffer | Buffer[]; a fragmented frame arrives
      // as the array and must be joined, not passed to Buffer.from().
      if (Buffer.isBuffer(d)) sock.write(d);
      else if (Array.isArray(d)) sock.write(Buffer.concat(d));
      else sock.write(Buffer.from(d));
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
