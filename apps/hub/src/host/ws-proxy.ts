import { createConnection } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

/**
 * Tunnel an HTTP Upgrade (noVNC `/websockify`) to the guest hub.
 * `fetch()` cannot carry 101; without this the edge answers the websocket
 * and the RFB handshake never reaches x11vnc.
 */
export function proxyUpgradeToGuest(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  ip: string,
  port = 8080,
): void {
  const guest = createConnection({ host: ip, port });
  const fail = () => {
    guest.destroy();
    socket.destroy();
  };
  guest.on("error", fail);
  socket.on("error", fail);
  guest.once("connect", () => {
    const lines = [`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1`];
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      lines.push(`${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    lines.push("", "");
    guest.write(lines.join("\r\n"));
    if (head.length) guest.write(head);
    guest.pipe(socket);
    socket.pipe(guest);
  });
}
