import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseChannelPath } from "../src/handler/channels.ts";
import { ChannelRegistry, FileChannelStore, MemoryChannelStore } from "../src/service/channels.ts";
import { startHub } from "./helper.ts";

/** A stand-in Eve that records what reached it. */
function fakeEve(): Promise<{
  url: string;
  seen: { path: string; secret: string | undefined; turn: string | undefined; body: string }[];
  close: () => Promise<void>;
}> {
  const seen: {
    path: string;
    secret: string | undefined;
    turn: string | undefined;
    body: string;
  }[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      seen.push({
        body,
        path: req.url ?? "",
        secret: req.headers["x-computer-eve-secret"] as string | undefined,
        turn: req.headers["x-computer-turn"] as string | undefined,
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: "hi" }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        seen,
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

describe("channel registry", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it("mints a secret once, lists without it, rotates and removes", () => {
    const reg = new ChannelRegistry(new MemoryChannelStore());
    const rec = reg.add({ bot: "main", id: "whatsapp-main", kind: "whatsapp" });
    expect(rec.secret).toHaveLength(43);
    expect(reg.list()).toEqual([
      expect.objectContaining({ bot: "main", id: "whatsapp-main", kind: "whatsapp" }),
    ]);
    expect(JSON.stringify(reg.list())).not.toContain(rec.secret);
    expect(() => reg.add({ bot: "main", id: "whatsapp-main", kind: "whatsapp" })).toThrow(
      /already exists/,
    );
    const rotated = reg.rotate("whatsapp-main");
    expect(rotated.secret).not.toBe(rec.secret);
    expect(() => reg.verify("whatsapp-main", rec.secret)).toThrow(/bad channel secret/);
    expect(reg.verify("whatsapp-main", rotated.secret).bot).toBe("main");
    expect(reg.remove("whatsapp-main")).toBe(true);
    expect(reg.remove("whatsapp-main")).toBe(false);
  });

  it("refuses a wrong or missing secret without locking the door", () => {
    const reg = new ChannelRegistry();
    const a = reg.add({ bot: "main", id: "a", kind: "webhook" });
    for (let i = 0; i < 20; i += 1) {
      expect(() => reg.verify("a", "wrong")).toThrow(/bad channel secret/);
    }
    expect(() => reg.verify("a", undefined)).toThrow(/bad channel secret/);
    expect(() => reg.verify("nope", a.secret)).toThrow(/bad channel secret/);
    // The bridge's next message still goes through: a flood of junk secrets
    // at the public ingress must not become a denial of service.
    expect(reg.verify("a", a.secret).id).toBe("a");
  });

  it("sees a door written to channels.json by another process", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-channels-"));
    dirs.push(dir);
    const path = join(dir, "channels.json");
    const hub = new ChannelRegistry(new FileChannelStore(path));
    hub.add({ bot: "main", id: "first", kind: "webhook" });
    // `npm run bot -- channel add` behind a running hub.
    const cli = new ChannelRegistry(new FileChannelStore(path));
    const hook = cli.add({ bot: "main", id: "hooks", kind: "webhook" });
    expect(hub.verify("hooks", hook.secret).id).toBe("hooks");
    // And the hub's next write keeps it.
    hub.rotate("first");
    expect(cli.list().map((r) => r.id)).toEqual(["first", "hooks"]);
  });

  it("persists 0600 in a 0700 dir and reloads", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-channels-"));
    dirs.push(dir);
    const path = join(dir, "data", "channels.json");
    const rec = new ChannelRegistry(new FileChannelStore(path)).add({
      bot: "main",
      id: "whatsapp-main",
      kind: "whatsapp",
      paths: ["/eve/v1/whatsapp/message"],
    });
    const perms = (p: string) => statSync(p).mode.toString(8).slice(-3);
    expect(perms(path)).toBe("600");
    expect(perms(join(dir, "data"))).toBe("700");
    const again = new ChannelRegistry(new FileChannelStore(path));
    expect(again.verify("whatsapp-main", rec.secret).paths).toEqual(["/eve/v1/whatsapp/message"]);
  });

  it("parses ingress paths and refuses traversal", () => {
    expect(parseChannelPath("/channels/whatsapp-main/message")).toEqual({
      id: "whatsapp-main",
      rest: "message",
    });
    expect(parseChannelPath("/channels/hook/a/b")).toEqual({ id: "hook", rest: "a/b" });
    expect(parseChannelPath("/channels/hook")).toBeUndefined();
    expect(parseChannelPath("/channels/hook/")).toBeUndefined();
    expect(parseChannelPath("/channels/hook/../x")).toBeUndefined();
  });
});

describe("channel ingress", () => {
  it("forwards a POST with the right secret to the Bot's Eve with the hub secret", async () => {
    const eve = await fakeEve();
    const h = await startHub({ eveSecret: "hub-secret", eveUrls: { main: eve.url } });
    try {
      const rec = h.hub.channels.add({
        bot: "main",
        id: "whatsapp-main",
        kind: "whatsapp",
        paths: ["/eve/v1/whatsapp/message"],
      });
      const res = await fetch(`${h.url}/channels/whatsapp-main/message`, {
        body: JSON.stringify({ message: "hello", token: "g@g.us" }),
        headers: { "content-type": "application/json", "x-channel-secret": rec.secret },
        method: "POST",
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ reply: "hi" });
      expect(eve.seen).toEqual([
        expect.objectContaining({
          path: "/eve/v1/whatsapp/message",
          secret: "hub-secret",
        }),
      ]);
      expect(JSON.parse(eve.seen[0]!.body)).toEqual({ message: "hello", token: "g@g.us" });

      // Wrong secret, no secret, a seat token: none of them open the door.
      const wrong = await fetch(`${h.url}/channels/whatsapp-main/message`, {
        body: "{}",
        headers: { "x-channel-secret": "nope" },
        method: "POST",
      });
      expect(wrong.status).toBe(401);
      const owner = await h.pair();
      const seat = await fetch(`${h.url}/channels/whatsapp-main/message`, {
        body: "{}",
        headers: { authorization: `Bearer ${owner}` },
        method: "POST",
      });
      expect(seat.status).toBe(401);
      // A path outside the record's allowlist is refused before Eve sees it.
      const other = await fetch(`${h.url}/channels/whatsapp-main/admin`, {
        body: "{}",
        headers: { "x-channel-secret": rec.secret },
        method: "POST",
      });
      expect(other.status).toBe(403);
      // GET is not a door.
      const get = await fetch(`${h.url}/channels/whatsapp-main/message`, {
        headers: { "x-channel-secret": rec.secret },
      });
      expect(get.status).toBe(400);
      expect(eve.seen).toHaveLength(1);
    } finally {
      await h.close();
      await eve.close();
    }
  });

  it("resolves the chat to a conversation once and mints a fresh turn per message", async () => {
    const eve = await fakeEve();
    const h = await startHub({ eveSecret: "hub-secret", eveUrls: { main: eve.url } });
    try {
      const rec = h.hub.channels.add({
        bot: "main",
        id: "whatsapp-main",
        kind: "whatsapp",
        paths: ["/eve/v1/whatsapp/message"],
      });
      const post = (body: unknown) =>
        fetch(`${h.url}/channels/whatsapp-main/message`, {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json", "x-channel-secret": rec.secret },
          method: "POST",
        });
      const inbound = {
        acct: "main",
        message: "hello",
        sender: "1@s.whatsapp.net",
        token: "g@g.us",
      };
      const first = await post(inbound);
      const second = await post({ ...inbound, message: "again" });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      // One conversation for the route, participants from the first sight.
      expect(h.hub.conversations.list()).toEqual([
        expect.objectContaining({
          bot: "main",
          participants: [
            { bot: "main", kind: "bot" },
            { kind: "human", ref: "1@s.whatsapp.net" },
          ],
          route: { acct: "main", jid: "g@g.us", kind: "whatsapp" },
        }),
      ]);

      // A turn token per message, never reused: it is one turn's reach.
      const turns = eve.seen.map((s) => s.turn);
      expect(turns.every((t) => typeof t === "string" && t.startsWith("turn_"))).toBe(true);
      expect(new Set(turns).size).toBe(2);
      // It never touches the response the bridge reads, and it is bound to
      // the conversation the hub resolved, which the body never names.
      expect(eve.seen[0]!.body).not.toContain("turn_");
      expect(eve.seen[0]!.body).not.toContain("conv_");

      // A second chat on the same number is its own conversation.
      await post({ ...inbound, token: "other@g.us" });
      expect(h.hub.conversations.list()).toHaveLength(2);
    } finally {
      await h.close();
      await eve.close();
    }
  });

  it("binds nothing for a door with no chat behind it", async () => {
    const eve = await fakeEve();
    const h = await startHub({ eveSecret: "hub-secret", eveUrls: { main: eve.url } });
    try {
      const hook = h.hub.channels.add({ bot: "main", id: "hooks", kind: "webhook" });
      const wa = h.hub.channels.add({ bot: "main", id: "whatsapp-main", kind: "whatsapp" });
      const post = (id: string, secret: string, body: string) =>
        fetch(`${h.url}/channels/${id}/message`, {
          body,
          headers: { "content-type": "application/json", "x-channel-secret": secret },
          method: "POST",
        });
      // A webhook has no chat to be a conversation with.
      await post("hooks", hook.secret, JSON.stringify({ anything: true }));
      // Neither has a WhatsApp body the bridge would never send. The ingress
      // forwards it untouched and lets Eve answer with its own 400 rather
      // than becoming a second validator of a payload it proxies.
      await post("whatsapp-main", wa.secret, "not json");
      await post("whatsapp-main", wa.secret, JSON.stringify({ message: "hi" }));
      expect(eve.seen.map((s) => s.turn)).toEqual([undefined, undefined, undefined]);
      expect(h.hub.conversations.list()).toEqual([]);
    } finally {
      await h.close();
      await eve.close();
    }
  });

  it("answers DAEMON_DOWN when the Bot has no Eve", async () => {
    const h = await startHub({ eveUrls: { main: "" } });
    try {
      const rec = h.hub.channels.add({ bot: "main", id: "hook", kind: "webhook" });
      const res = await fetch(`${h.url}/channels/hook/in`, {
        body: "{}",
        headers: { "x-channel-secret": rec.secret },
        method: "POST",
      });
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ error: { code: "DAEMON_DOWN" } });
    } finally {
      await h.close();
    }
  });
});
