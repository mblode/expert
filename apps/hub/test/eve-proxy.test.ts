import { afterEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { startHub } from "./helper.ts";

type Opened = Awaited<ReturnType<typeof startHub>>;

type FakeEve = {
  server: Server;
  url: string;
  /** What the upstream saw on the last request. */
  seen: { method?: string; url?: string; authorization?: string; body: string }[];
};

/** Stands in for `eve dev --no-ui --port 2000`. */
function fakeEve(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<FakeEve> {
  const seen: FakeEve["seen"] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({
          method: req.method,
          url: req.url,
          authorization: Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization,
          body,
        });
        handler(req, res, body);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({ server, url: `http://127.0.0.1:${addr.port}`, seen });
    });
  });
}

/** A port nothing listens on: bind, read the port, close. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no addr");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return addr.port;
}

describe("eve proxy: one origin, one credential", () => {
  const opened: Opened[] = [];
  const servers: Server[] = [];
  const priorEveUrl = process.env.COMPUTER_EVE_URL;

  afterEach(async () => {
    while (opened.length) await opened.pop()!.close();
    while (servers.length) await new Promise<void>((r) => servers.pop()!.close(() => r()));
    if (priorEveUrl === undefined) delete process.env.COMPUTER_EVE_URL;
    else process.env.COMPUTER_EVE_URL = priorEveUrl;
  });

  /** Boots a hub pointed at `eveUrl`, paired, and returns the seat token. */
  async function hubAt(eveUrl: string) {
    process.env.COMPUTER_EVE_URL = eveUrl;
    const h = await startHub();
    opened.push(h);
    return { h, token: await h.pair() };
  }

  it("refuses a call without a seat token", async () => {
    const eve = await fakeEve((_req, res) => res.end("{}"));
    servers.push(eve.server);
    const { h } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: { code: "UNAUTHENTICATED", message: "seat token required" },
    });
    expect(eve.seen).toHaveLength(0);
  });

  it("forwards method, body, status and JSON — without the seat token", async () => {
    const eve = await fakeEve((_req, res, body) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "sess_1", echo: JSON.parse(body || "{}") }));
    });
    servers.push(eve.server);
    const { h, token } = await hubAt(eve.url);

    const res = await fetch(`${h.url}/eve/v1/session?foo=bar`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "say hi" }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ id: "sess_1", echo: { message: "say hi" } });

    expect(eve.seen).toHaveLength(1);
    const seen = eve.seen[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.url).toBe("/eve/v1/session?foo=bar");
    // Eve's localDev auth trusts loopback; the seat token is the hub's, not hers.
    expect(seen.authorization).toBeUndefined();
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

  it("streams NDJSON through unbuffered", async () => {
    let wroteSecond = false;
    let releaseSecond = () => {};
    const clientSawFirst = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const eve = await fakeEve((_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"event":"one"}\n');
      // Only write the second line once the client has proven it saw the first;
      // a buffering proxy never gets here and the read below times out.
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
    // The regression that matters: line one arrived before line two existed.
    expect(wroteSecond).toBe(false);

    releaseSecond();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
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

  it("reports DAEMON_DOWN when the agent is not running", async () => {
    const { h, token } = await hubAt(`http://127.0.0.1:${await closedPort()}`);

    const res = await fetch(`${h.url}/eve/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "DAEMON_DOWN", message: expect.stringContaining("npm run eve") },
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
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
