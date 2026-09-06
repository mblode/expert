import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { EVE_HUB_SECRET_HEADER } from "@computer/shared";
import { startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

interface FakeEve {
  server: Server;
  url: string;
  seen: { method?: string; url?: string; authorization?: string; secret?: string; body: string }[];
}

function fakeEve(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<FakeEve> {
  const seen: FakeEve["seen"] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        seen.push({
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization,
          body,
          method: req.method,
          secret: Array.isArray(req.headers[EVE_HUB_SECRET_HEADER])
            ? req.headers[EVE_HUB_SECRET_HEADER][0]
            : req.headers[EVE_HUB_SECRET_HEADER],
          url: req.url,
        });
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no addr");
      }
      resolve({ seen, server, url: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("no addr");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return addr.port;
}

describe("eve proxy: seat token → bot → that bot's Eve", () => {
  const opened: Opened[] = [];
  const servers: Server[] = [];
  const priorEveUrl = process.env.COMPUTER_EVE_URL;

  afterEach(async () => {
    while (opened.length) {
      await opened.pop()!.close();
    }
    while (servers.length) {
      await new Promise<void>((r) => servers.pop()!.close(() => r()));
    }
    if (priorEveUrl === undefined) {
      delete process.env.COMPUTER_EVE_URL;
    } else {
      process.env.COMPUTER_EVE_URL = priorEveUrl;
    }
  });

  async function hubAt(eveUrl: string, extra: Parameters<typeof startHub>[0] = {}) {
    const h = await startHub({
      eveSecret: "eve-secret-test",
      eveUrls: { main: eveUrl },
      ...extra,
    });
    opened.push(h);
    return { h, token: await h.pair() };
  }

  it("refuses a call without a seat token", async () => {
    const eve = await fakeEve((_req, res) => res.end("{}"));
    servers.push(eve.server);
    const { h } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session`, {
      body: JSON.stringify({ message: "hi" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "seat token required" },
    });
    expect(eve.seen).toHaveLength(0);
  });

  it("forwards method, body, status and JSON: without the seat token, with the hub secret", async () => {
    const eve = await fakeEve((_req, res, body) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ echo: JSON.parse(body || "{}"), id: "sess_1" }));
    });
    servers.push(eve.server);
    const { h, token } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session?foo=bar`, {
      body: JSON.stringify({ message: "say hi" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ echo: { message: "say hi" }, id: "sess_1" });

    expect(eve.seen).toHaveLength(1);
    const seen = eve.seen[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/eve/v1/session?foo=bar");
    expect(seen.authorization).toBeUndefined();
    expect(seen.secret).toBe("eve-secret-test");
  });

  it("accepts the seat token as ?token= and keeps it out of the upstream url", async () => {
    const eve = await fakeEve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    servers.push(eve.server);
    const { h, token } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session?token=${token}`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(eve.seen[0]!.url).toBe("/eve/v1/session");
  });

  it("routes each bot to its own Eve", async () => {
    const eveA = await fakeEve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ who: "a" }));
    });
    const eveB = await fakeEve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ who: "b" }));
    });
    servers.push(eveA.server, eveB.server);

    const h = await startHub({
      bots: [
        { id: "a", display: 1, token: "token-a" },
        { id: "b", display: 2, token: "token-b" },
      ],
      eveSecret: "eve-secret-test",
      eveUrls: { a: eveA.url, b: eveB.url },
    });
    opened.push(h);
    const token = await h.pair();

    const toA = await fetch(`${h.url}/eve/v1/session`, {
      headers: { authorization: `Bearer ${token}`, "x-computer-bot": "a" },
      method: "POST",
    });
    expect(await toA.json()).toEqual({ who: "a" });
    expect(eveA.seen).toHaveLength(1);
    expect(eveB.seen).toHaveLength(0);

    const toB = await fetch(`${h.url}/eve/v1/session?bot=b`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    expect(await toB.json()).toEqual({ who: "b" });
    expect(eveB.seen).toHaveLength(1);
    expect(eveB.seen[0]!.url).toBe("/eve/v1/session");
  });

  it("streams NDJSON through unbuffered", async () => {
    let wroteSecond = false;
    let releaseSecond = () => {};
    const clientSawFirst = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const eve = await fakeEve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"event":"one"}\n');
      const timeout = setTimeout(releaseSecond, 2000);
      void clientSawFirst.then(() => {
        clearTimeout(timeout);
        wroteSecond = true;
        res.write('{"event":"two"}\n');
        res.end();
      });
    });
    servers.push(eve.server);
    const { h, token } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session/sess_1/stream`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"one"');
    expect(wroteSecond).toBe(false);

    releaseSecond();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      rest += decoder.decode(chunk.value);
    }
    expect(rest).toContain('"two"');
  });

  it("aborts upstream when the client hangs up", async () => {
    let upstreamClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const eve = await fakeEve((req, res) => {
      req.on("close", () => upstreamClosed());
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"event":"one"}\n');
    });
    servers.push(eve.server);
    const { h, token } = await hubAt(eve.url);

    const abort = new AbortController();
    const res = await fetch(`${h.url}/eve/v1/session/sess_1/stream`, {
      headers: { authorization: `Bearer ${token}` },
      signal: abort.signal,
    });
    await res.body!.getReader().read();
    abort.abort();
    await closed;
  });

  it("reports DAEMON_DOWN when that bot's Eve is not running", async () => {
    const { h, token } = await hubAt(`http://127.0.0.1:${await closedPort()}`);

    const res = await fetch(`${h.url}/eve/v1/session`, {
      body: JSON.stringify({ message: "hi" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string; message: string } }).toMatchObject({
      error: { code: "DAEMON_DOWN", message: expect.stringContaining("bot main") },
    });
  });

  it("reports DAEMON_DOWN when this bot has no Eve URL", async () => {
    const h = await startHub({ eveUrls: { main: "" } });
    opened.push(h);
    const token = await h.pair();
    const res = await fetch(`${h.url}/eve/v1/session`, {
      headers: { authorization: `Bearer ${token}` },
      method: "POST",
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "DAEMON_DOWN" },
    });
  });

  it("answers the browser preflight with authorization and content-type", async () => {
    const eve = await fakeEve((_req, res) => res.end("{}"));
    servers.push(eve.server);
    const { h } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(res.headers.get("access-control-allow-headers")).toContain("x-computer-bot");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
