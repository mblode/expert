import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createServer, type Server } from "node:net";
import { FakeDesk } from "../src/desk/fake.ts";
import { NoopWindowManager, ownerHash } from "../src/desk/windows.ts";
import { BotRegistry } from "../src/service/bots.ts";
import { rpc, startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

/** Two Bots on one box: a on :1, b on :2. */
async function startTwoBots() {
  const deskA = new FakeDesk({ display: 1 });
  const deskB = new FakeDesk({ display: 2 });
  const h = await startHub(deskA, {
    bots: [
      { id: "a", display: 1, token: "token-a", desk: deskA },
      { id: "b", display: 2, token: "token-b", desk: deskB },
    ],
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
    expect(b.vnc_url).toContain(`token=${token}`);
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

  it("registry rejects duplicate displays, ids, and tokens", () => {
    const desk = () => new FakeDesk();
    expect(
      () =>
        new BotRegistry([
          { id: "a", display: 1, token: "t1", desk: desk() },
          { id: "a", display: 2, token: "t2", desk: desk() },
        ]),
    ).toThrow(/duplicate bot id/);
    expect(
      () =>
        new BotRegistry([
          { id: "a", display: 1, token: "t1", desk: desk() },
          { id: "b", display: 1, token: "t2", desk: desk() },
        ]),
    ).toThrow(/duplicate bot display/);
    expect(
      () =>
        new BotRegistry([
          { id: "a", display: 1, token: "t1", desk: desk() },
          { id: "b", display: 2, token: "t1", desk: desk() },
        ]),
    ).toThrow(/duplicate bot token/);
    expect(() => new BotRegistry([{ id: "a", display: 9, token: "t1", desk: desk() }])).toThrow(/display must be/);
  });

  it("ensureWindows claims each configured display", async () => {
    const desk = () => new FakeDesk();
    const bots = new BotRegistry([
      { id: "a", display: 1, token: "t1", desk: desk() },
      { id: "b", display: 2, token: "t2", desk: desk() },
    ]);
    const windows = new NoopWindowManager();
    await bots.ensureWindows(windows);
    expect(windows.started).toEqual([1, 2]);
  });

  it("owner hash is a sha256, never the raw token", () => {
    const h = ownerHash("token-a");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("token-a");
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
    const deskA = new FakeDesk({ display: 1 });
    const deskB = new FakeDesk({ display: 2 });
    const b = await new Promise<Server>((resolve, reject) => {
      const server = createServer((sock) => sock.write("rfb-display-2"));
      servers.push(server);
      server.once("error", reject);
      server.listen(basePort + 2, "127.0.0.1", () => resolve(server));
    }).catch(() => null);
    const h = await startHub(deskA, {
      bots: [
        { id: "a", display: 1, token: "token-a", desk: deskA },
        { id: "b", display: 2, token: "token-b", desk: deskB },
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
});
