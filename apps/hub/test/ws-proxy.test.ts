import { createServer, type AddressInfo, type IncomingMessage } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createEdgeServer } from "../src/host/edge-server.ts";
import {
  buildUpgradePreamble,
  guestHttpUrl,
  isUpgradeRequest,
  throttle,
} from "../src/host/ws-proxy.ts";

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
});

function listenZero(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        reject(new Error("no port"));
        return;
      }
      resolve(addr.port);
    });
    server.once("error", reject);
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const runningGuest = [
  {
    id: "box1",
    state: "started",
    private_ip: "127.0.0.1",
    config: { metadata: { fly_process_group: "computer" } },
  },
];

function flyFetchOk(body: unknown = runningGuest) {
  return async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(body),
  });
}

describe("ws-proxy helpers", () => {
  it("detects a websocket upgrade", () => {
    expect(isUpgradeRequest({ headers: { upgrade: "websocket" } })).toBe(true);
    expect(isUpgradeRequest({ headers: { upgrade: "WebSocket" } })).toBe(true);
    expect(isUpgradeRequest({ headers: {} })).toBe(false);
  });

  it("brackets IPv6 guest URLs for fetch", () => {
    expect(guestHttpUrl("fdaa:1:2::3", "/vnc")).toBe("http://[fdaa:1:2::3]:8080/vnc");
    expect(guestHttpUrl("127.0.0.1", "/websockify?x=1")).toBe("http://127.0.0.1:8080/websockify?x=1");
  });

  it("replays the Upgrade request onto the guest, rewriting Host", () => {
    const text = buildUpgradePreamble(
      {
        method: "GET",
        url: "/websockify?token=abc",
        headers: {
          host: "app.fly.dev",
          upgrade: "websocket",
          connection: "Upgrade",
          "sec-websocket-key": "x",
          "sec-websocket-version": "13",
        },
      } as IncomingMessage,
      "fdaa::1",
    ).toString();
    expect(text.startsWith("GET /websockify?token=abc HTTP/1.1\r\n")).toBe(true);
    expect(text).toContain("Host: [fdaa::1]:8080\r\n");
    expect(text).toContain("upgrade: websocket\r\n");
    expect(text.endsWith("\r\n\r\n")).toBe(true);
    expect(text).not.toContain("app.fly.dev");
  });

  it("throttles activity so a pixel stream does not stamp every frame", () => {
    let n = 0;
    let now = 0;
    const bump = throttle(() => {
      n += 1;
    }, 30_000, () => now);
    bump();
    bump();
    expect(n).toBe(1);
    now = 29_999;
    bump();
    expect(n).toBe(1);
    now = 30_000;
    bump();
    expect(n).toBe(2);
  });
});

describe("edge websocket tunnel", () => {
  it("pipes noVNC upgrade through to the guest and refreshes idle", async () => {
    const guest = createServer();
    const gwss = new WebSocketServer({ server: guest });
    gwss.on("connection", (ws) => {
      ws.on("message", (d) => ws.send(`echo:${d}`));
    });
    const guestPort = await listenZero(guest);
    opened.push({
      close: async () => {
        gwss.close();
        await closeServer(guest);
      },
    });

    const lastUse = { t: 0 };
    const edge = createEdgeServer({
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer" },
      fetch: flyFetchOk(),
      lastUse,
      guestPort,
      activityIntervalMs: 1,
    });
    const edgePort = await listenZero(edge.server);
    opened.push({ close: () => closeServer(edge.server) });

    const ws = new WebSocket(`ws://127.0.0.1:${edgePort}/websockify?token=pix`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    expect(lastUse.t).toBeGreaterThan(0);
    const stamped = lastUse.t;
    lastUse.t = 1;
    ws.send("frame");
    const echoed = await new Promise<string>((resolve, reject) => {
      ws.once("message", (d) => resolve(String(d)));
      ws.once("error", reject);
    });
    expect(echoed).toBe("echo:frame");
    expect(lastUse.t).toBeGreaterThan(1);
    expect(lastUse.t).toBeGreaterThanOrEqual(stamped);
    ws.close();
  });

  it("does not refresh idle on a proxied Status poll", async () => {
    const guest = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ state: "running" }));
    });
    const guestPort = await listenZero(guest);
    opened.push({ close: () => closeServer(guest) });

    const lastUse = { t: 42 };
    const edge = createEdgeServer({
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer" },
      fetch: flyFetchOk(),
      lastUse,
      guestPort,
    });
    const edgePort = await listenZero(edge.server);
    opened.push({ close: () => closeServer(edge.server) });

    const res = await fetch(`http://127.0.0.1:${edgePort}/computer.v1.Seat/Status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(lastUse.t).toBe(42);
  });
});
