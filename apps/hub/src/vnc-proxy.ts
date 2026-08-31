import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * websockify: noVNC talks RFC6455; TigerVNC talks raw RFB on :5900.
 * Bound only via the hub, which itself binds 127.0.0.1.
 */
export function attachVncProxy(
  wss: WebSocketServer,
  opts: { host: string; port: number },
): void {
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/websockify" && url.pathname !== "/vnc/websockify") {
      ws.close();
      return;
    }
    const sock = createConnection({ host: opts.host, port: opts.port });
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
