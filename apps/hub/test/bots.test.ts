import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerError } from "@computer/shared";
import { FakeDesk } from "../src/desk/fake.ts";
import { ownerHash } from "../src/desk/windows.ts";
import { BotRegistry } from "../src/service/bots.ts";
import { FileBotStore } from "../src/service/provision.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

/** Two Bots on one box: a on :1, b on :2. */
async function startTwoBots() {
  const deskA = new FakeDesk({ display: 1 });
  const deskB = new FakeDesk({ display: 2 });
  const h = await startHub({
    bots: [
      { id: "a", display: 1, token: "token-a" },
      { id: "b", display: 2, token: "token-b" },
    ],
    desks: new Map([
      [1, deskA],
      [2, deskB],
    ]),
  });
  return { ...h, deskA, deskB };
}

describe("bots: one shared box, one screen per Bot", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
  });

  it("routes each agent token to its own screen", async () => {
    const h = await startTwoBots();
    opened.push(h);

    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "r1", actions: [{ type: "click", x: 10, y: 20 }] }, "token-a");
    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "r2", actions: [{ type: "click", x: 30, y: 40 }] }, "token-b");

    expect(h.deskA.log).toContain("click left 10,20");
    expect(h.deskA.log).not.toContain("click left 30,40");
    expect(h.deskB.log).toContain("click left 30,40");
    expect(h.deskB.log).not.toContain("click left 10,20");
  });

  it("rejects an unknown agent token", async () => {
    const h = await startTwoBots();
    opened.push(h);
    await expect(
      rpc(h.url, "/computer.v1.Agent/Spec", {}, "token-c"),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("SEAT_HELD is per screen: takeover on a leaves b runnable", async () => {
    const h = await startTwoBots();
    opened.push(h);

    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "t1", actions: [{ type: "request_takeover" }] }, "token-a");
    await expect(
      rpc(h.url, "/computer.v1.Agent/Shell", { request_id: "s1", argv: ["echo", "hi"] }, "token-a"),
    ).rejects.toMatchObject({ code: "SEAT_HELD" });

    const r = (await rpc(
      h.url,
      "/computer.v1.Agent/Shell",
      { request_id: "s2", argv: ["echo", "hi"] },
      "token-b",
    )) as { exit: number };
    expect(r.exit).toBe(0);
  });

  it("SetPresence with display releases only that screen", async () => {
    const h = await startTwoBots();
    opened.push(h);
    const token = await h.pair();

    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "t1", actions: [{ type: "request_takeover" }] }, "token-a");
    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "t2", actions: [{ type: "request_takeover" }] }, "token-b");

    const s = (await rpc(h.url, "/computer.v1.Seat/SetPresence", { present: false, display: 2 }, token)) as {
      state: string;
      screens: { bot_id: string; display: number; state: string }[];
    };
    expect(s.state).toBe("AGENT");
    const byId = Object.fromEntries(s.screens.map((x) => [x.bot_id, x.state]));
    expect(byId.a).toBe("WAITING");
    expect(byId.b).toBe("AGENT");
  });

  it("Status lists screens with per-display vnc urls", async () => {
    const h = await startTwoBots();
    opened.push(h);
    const token = await h.pair();
    const s = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as {
      vnc_url: string;
      screens: { bot_id: string; display: number; vnc_url: string }[];
    };
    expect(s.screens).toHaveLength(2);
    const b = s.screens.find((x) => x.bot_id === "b")!;
    expect(b.vnc_url).toContain("display=2");
    expect(b.vnc_url).toContain("token=");
    expect(new URL(b.vnc_url).searchParams.get("token")).not.toBe(token);
    const a = s.screens.find((x) => x.bot_id === "a")!;
    expect(a.vnc_url).not.toContain("display=");
  });

  it("Seat display outside 1..8 or unassigned is VALIDATION", async () => {
    const h = await startTwoBots();
    opened.push(h);
    const token = await h.pair();
    await expect(rpc(h.url, "/computer.v1.Seat/Status", { display: 9 }, token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/Status", { display: 3 }, token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("Pointer and Type route by display", async () => {
    const h = await startTwoBots();
    opened.push(h);
    const token = await h.pair();
    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "t1", actions: [{ type: "request_takeover" }] }, "token-b");

    await rpc(h.url, "/computer.v1.Seat/Pointer", { type: "move", dx: 5, dy: 5, display: 2 }, token);
    await rpc(h.url, "/computer.v1.Seat/Type", { text: "hello", display: 2 }, token);

    expect(h.deskB.log.some((l) => l.startsWith("delta 5,5"))).toBe(true);
    expect(h.deskB.lastType).toBe("hello");
    expect(h.deskA.log).toHaveLength(0);
    // Screen 1 is still AGENT: human pointer there is rejected.
    await expect(
      rpc(h.url, "/computer.v1.Seat/Pointer", { type: "move", dx: 1, dy: 1 }, token),
    ).rejects.toMatchObject({ code: "SEAT_HELD" });
  });

  it("chat runs per bot and rejects a concurrent chat for a busy bot", async () => {
    const h = await startTwoBots();
    opened.push(h);
    const token = await h.pair();

    const chat = (body: unknown) =>
      fetch(`${h.url}/chat`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // Unknown bot is a 400.
    const unknown = await chat({ message: "hi", bot_id: "nope" });
    expect(unknown.status).toBe(400);

    // Two bots chat concurrently (echo loop, no API key).
    const [ra, rb] = await Promise.all([
      chat({ message: "hi", bot_id: "a" }),
      chat({ message: "hi", bot_id: "b" }),
    ]);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    expect(await ra.text()).toContain("Hub is up");
    expect(await rb.text()).toContain("Hub is up");
  });

  it("registry rejects duplicates, bad ids, and out-of-range displays", () => {
    const factory = (display: number) => new FakeDesk({ display });
    const make = (configs: Parameters<typeof BotRegistry.prototype.add>[0][]) =>
      new BotRegistry(factory, configs);
    expect(() =>
      make([
        { id: "a", display: 1, token: "t1" },
        { id: "a", display: 2, token: "t2" },
      ]),
    ).toThrow(/already exists/);
    expect(() =>
      make([
        { id: "a", display: 1, token: "t1" },
        { id: "b", display: 1, token: "t2" },
      ]),
    ).toThrow(/display 1 is taken/);
    expect(() =>
      make([
        { id: "a", display: 1, token: "t1" },
        { id: "b", display: 2, token: "t1" },
      ]),
    ).toThrow(/token already in use/);
    expect(() => make([{ id: "a", display: 9, token: "t1" }])).toThrow(/display must be/);
    expect(() => make([{ id: "Bad Name!", display: 1, token: "t1" }])).toThrow(/bot id must be/);
  });

  it("owner hash is a sha256, never the raw token", () => {
    const h = ownerHash("token-a");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("token-a");
  });
});

describe("provisioning: computer as a service", () => {
  const opened: Opened[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
  });

  it("boots an empty store into a primary bot with a minted token", async () => {
    const h = await startHub({ bots: [] });
    opened.push(h);
    const bots = h.hub.bots.all();
    expect(bots).toHaveLength(1);
    expect(bots[0]!.id).toBe("main");
    expect(bots[0]!.display).toBe(1);
    expect(bots[0]!.token).toMatch(/^bot_/);
    expect(h.store.load()).toHaveLength(1);
    expect(h.windows.started).toEqual([1]);
  });

  it("CreateBot allocates the next screen, mints a token, claims the window, persists", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();

    const r = (await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, token)) as {
      id: string;
      display: number;
      token: string;
    };
    expect(r.id).toBe("night");
    expect(r.display).toBe(2);
    expect(r.token).toMatch(/^bot_/);
    expect(h.windows.started).toContain(2);
    expect(h.store.load().map((b) => b.id)).toEqual(["main", "night"]);

    // The minted token drives the new screen immediately.
    await rpc(h.url, "/computer.v1.Agent/Computer", { request_id: "r1", actions: [{ type: "click", x: 1, y: 1 }] }, r.token);
    expect(h.desks.get(2)!.log).toContain("click left 1,1");
  });

  it("DeleteBot releases the screen and revokes the token", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const r = (await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, token)) as { token: string };

    await rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "night" }, token);
    expect(h.windows.stopped).toEqual([2]);
    expect(h.store.load().map((b) => b.id)).toEqual(["main"]);
    await expect(rpc(h.url, "/computer.v1.Agent/Spec", {}, r.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    // The display is free again.
    const again = (await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "day" }, token)) as { display: number };
    expect(again.display).toBe(2);
  });

  it("refuses duplicates, bad ids, deleting the primary, and requires a seat token", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    await expect(rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "main" }, token)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "Bad Name!" }, token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "main" }, token)).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "x" }, h.agent)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("caps the box at 8 screens with a CONFLICT that names the fix", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    for (let i = 2; i <= 8; i++) {
      await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: `bot-${i}` }, token);
    }
    await expect(rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "one-more" }, token)).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("delete a bot"),
    });
  });

  it("a failed window claim rolls the bot back", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    h.windows.failNext = true;
    await expect(rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, token)).rejects.toMatchObject({
      code: "DAEMON_DOWN",
    });
    expect(h.hub.bots.all().map((b) => b.id)).toEqual(["main"]);
    expect(h.store.load().map((b) => b.id)).toEqual(["main"]);
  });

  it("claims the new window with force: the roster, not the box, owns the display", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, token);
    // allocateDisplay() only hands out a display no Bot holds, so any claim
    // left on the box for :2 is stale and must not brick provisioning.
    expect(h.windows.forced).toContain(2);
  });

  it("a failing stopWindow still completes the removal", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    await rpc(h.url, "/computer.v1.Seat/CreateBot", { id: "night" }, token);

    h.windows.stopWindow = async (display: number) => {
      throw new ComputerError("DAEMON_DOWN", `stop-window ${display} failed`);
    };

    await rpc(h.url, "/computer.v1.Seat/DeleteBot", { id: "night" }, token);
    expect(h.hub.bots.all().map((b) => b.id)).toEqual(["main"]);
    expect(h.store.load().map((b) => b.id)).toEqual(["main"]);
  });
});

describe("FileBotStore: the roster is the only record of every bot token", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  const tempDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-roster-"));
    dirs.push(dir);
    return dir;
  };

  it("throws on a corrupt roster instead of reading it as an empty box", () => {
    const path = join(tempDir(), "bots.json");
    writeFileSync(path, '[{"id":"main","display":1,"token":"bot_x"');
    // Returning [] here would let start() mint a new primary and save over
    // the file, destroying every existing token.
    const store = new FileBotStore(path);
    expect(() => store.load()).toThrow(new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(() => store.load()).toThrow(/JSON/);
  });

  it("throws when the roster parses but is not an array", () => {
    const path = join(tempDir(), "bots.json");
    writeFileSync(path, '{"bots":[]}');
    expect(() => new FileBotStore(path).load()).toThrow(/array/);
  });

  it("returns [] only when the roster file is absent", () => {
    const store = new FileBotStore(join(tempDir(), "missing", "bots.json"));
    expect(store.load()).toEqual([]);
  });

  it("round-trips a saved roster", () => {
    const path = join(tempDir(), "nested", "bots.json");
    const store = new FileBotStore(path);
    store.save([{ id: "main", display: 1, token: "bot_x" }]);
    expect(store.load()).toEqual([{ id: "main", display: 1, token: "bot_x" }]);
  });
});

describe("vnc proxy display routing", () => {
  const opened: Opened[] = [];
  const servers: Server[] = [];
  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
    while (servers.length) servers.pop()!.close();
  });

  /** Fake RFB server that greets with a marker so we can tell ports apart. */
  function fakeRfb(marker: string): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
      const server = createServer((sock) => {
        sock.write(marker);
      });
      servers.push(server);
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve({ server, port: addr.port });
      });
    });
  }

  function wsFirstMessage(url: string): Promise<string | number> {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(-1), 2000);
      const ws = new WebSocket(url);
      ws.on("message", (d) => {
        clearTimeout(t);
        ws.close();
        resolve(d.toString());
      });
      ws.on("close", (code) => {
        clearTimeout(t);
        resolve(code);
      });
      ws.on("error", () => {
        clearTimeout(t);
        resolve(4400);
      });
    });
  }

  it("?display=N dials basePort+N; invalid or unassigned display is refused", async () => {
    // Reserve two adjacent ports by binding throwaway servers, then reuse.
    const a = await fakeRfb("rfb-display-1");
    const basePort = a.port - 1;
    const b = await new Promise<Server>((resolve, reject) => {
      const server = createServer((sock) => sock.write("rfb-display-2"));
      servers.push(server);
      server.once("error", reject);
      server.listen(basePort + 2, "127.0.0.1", () => resolve(server));
    }).catch(() => null);
    const h = await startHub({
      bots: [
        { id: "a", display: 1, token: "token-a" },
        { id: "b", display: 2, token: "token-b" },
      ],
      vncBasePort: basePort,
    });
    opened.push(h);
    const token = await h.pair();
    const wsBase = `${h.url.replace("http", "ws")}/websockify`;

    expect(await wsFirstMessage(`${wsBase}?token=${token}`)).toBe("rfb-display-1");
    expect(await wsFirstMessage(`${wsBase}?token=${token}&display=1`)).toBe("rfb-display-1");
    if (b) {
      expect(await wsFirstMessage(`${wsBase}?token=${token}&display=2`)).toBe("rfb-display-2");
    }
    expect(await wsFirstMessage(`${wsBase}?token=${token}&display=3`)).toBe(4404);
    expect(await wsFirstMessage(`${wsBase}?token=${token}&display=99`)).toBe(4404);
  });

  it("forwards the client RFB version so the handshake continues past 003.008", async () => {
    const greeting = "RFB 003.008\n";
    let fromClient = Buffer.alloc(0);
    const rfb = createServer((sock) => {
      sock.write(greeting);
      sock.on("data", (d) => {
        fromClient = Buffer.concat([fromClient, d]);
        if (fromClient.includes(Buffer.from(greeting))) {
          // 1 security type: None — what noVNC expects after the version swap.
          sock.write(Buffer.from([1, 1]));
        }
      });
    });
    servers.push(rfb);
    const rfbPort = await new Promise<number>((resolve) => {
      rfb.listen(0, "127.0.0.1", () => {
        const addr = rfb.address();
        if (!addr || typeof addr === "string") throw new Error("no addr");
        resolve(addr.port);
      });
    });
    const h = await startHub({ vncBasePort: rfbPort - 1 });
    opened.push(h);
    const token = await h.pair();
    const ws = new WebSocket(`${h.url.replace("http", "ws")}/websockify?token=${token}`);
    const banner = await new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no banner")), 2000);
      ws.on("message", (d) => {
        clearTimeout(t);
        resolve(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      });
      ws.on("error", reject);
    });
    expect(banner.toString()).toBe(greeting);
    const security = new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("handshake stalled after version")), 2000);
      ws.on("message", (d) => {
        clearTimeout(t);
        resolve(Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer));
      });
    });
    ws.send(Buffer.from(greeting));
    expect(Buffer.from(await security)).toEqual(Buffer.from([1, 1]));
    expect(fromClient.toString()).toBe(greeting);
    ws.close();
  });
});
