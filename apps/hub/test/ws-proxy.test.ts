import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { proxyUpgradeToGuest } from "../src/host/ws-proxy.ts";

describe("edge websocket upgrade", () => {
  const close: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    while (close.length) await close.pop()?.();
  });

  it("tunnels /websockify so a client version reaches the guest", async () => {
    const guest = new WebSocketServer({ port: 0 });
    close.push(() => new Promise((resolve) => guest.close(() => resolve())));
    const seen: Buffer[] = [];
    guest.on("connection", (ws) => {
      ws.send(Buffer.from("RFB 003.008\n"), { binary: true });
      ws.on("message", (d) => {
        seen.push(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
        ws.send(Buffer.from([1, 1]), { binary: true });
      });
    });
    const addr = guest.address();
    if (!addr || typeof addr === "string") throw new Error("no guest addr");

    const edge = createServer();
    edge.on("upgrade", (req, socket, head) => {
      proxyUpgradeToGuest(req, socket, head, "127.0.0.1", addr.port);
    });
    await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve));
    close.push(() => new Promise((resolve) => edge.close(() => resolve())));
    const edgeAddr = edge.address();
    if (!edgeAddr || typeof edgeAddr === "string") throw new Error("no edge addr");

    const ws = new WebSocket(`ws://127.0.0.1:${edgeAddr.port}/websockify?token=t`);
    const banner = await new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no banner through edge")), 2000);
      ws.on("message", (d) => {
        clearTimeout(t);
        resolve(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      });
      ws.on("error", reject);
    });
    expect(banner.toString()).toBe("RFB 003.008\n");
    const reply = new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("edge dropped client version")), 2000);
      ws.on("message", (d) => {
        clearTimeout(t);
        resolve(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      });
    });
    ws.send(Buffer.from("RFB 003.008\n"));
    expect(Buffer.from(await reply)).toEqual(Buffer.from([1, 1]));
    expect(seen.some((b) => b.toString() === "RFB 003.008\n")).toBe(true);
    ws.close();
  });
});
