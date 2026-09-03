import { createServer } from "node:http";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { rpc, startHub } from "./helper.ts";

/**
 * A stand-in Eve for the WhatsApp channel: it takes the inbound, calls
 * `Agent.SendMessage` back on the hub with whatever turn header it was
 * handed, and answers `{ reply }` the way the real channel does.
 */
function replyingEve(
  hubUrl: () => string,
  agentToken: string,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const turn = req.headers["x-computer-turn"] as string | undefined;
      void fetch(`${hubUrl()}/computer.v1.Agent/SendMessage`, {
        body: JSON.stringify({ kind: "text", text: "on it" }),
        headers: {
          authorization: `Bearer ${agentToken}`,
          "content-type": "application/json",
          ...(turn ? { "x-computer-turn": turn } : {}),
        },
        method: "POST",
      })
        .then((r) => r.text())
        .then((sent) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ reply: "on it", sent: JSON.parse(sent) }));
        });
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        url: `http://127.0.0.1:${addr.port}`,
      });
    });
  });
}

const opened: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  while (opened.length) {
    await opened.pop()?.close();
  }
});

describe("Connect HTTP", () => {
  it("Pair exchanges setup code for a bearer and vncUrl", async () => {
    const h = await startHub();
    opened.push(h);
    const res = (await rpc(h.url, "/computer.v1.Seat/Pair", { code: h.setup })) as {
      token: string;
      vnc_url: string;
      status: { state: string; display: { width: number } };
    };
    expect(res.token.length).toBeGreaterThan(10);
    expect(res.vnc_url).toContain("view_only=1");
    expect(res.vnc_url).toContain("token=");
    // Pixel token in the URL, not the durable seat token from Pair.
    const pix = new URL(res.vnc_url).searchParams.get("token");
    expect(pix).toBeTruthy();
    expect(pix).not.toBe(res.token);
    expect(res.status.display.width).toBe(1280);
  });

  it("rejects a bad setup code and missing bearer", async () => {
    const h = await startHub();
    opened.push(h);
    await expect(rpc(h.url, "/computer.v1.Seat/Pair", { code: "nope" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
    await expect(rpc(h.url, "/computer.v1.Agent/Spec", {})).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      status: 401,
    });
  });

  it("Agent.Spec and GET /spec report computer.v1 1280×800", async () => {
    const h = await startHub();
    opened.push(h);
    const spec = (await rpc(h.url, "/computer.v1.Agent/Spec", {}, h.agent)) as {
      id: string;
      display: { width: number; height: number; scale: number };
      tools: string[];
    };
    expect(spec.id).toBe("computer.v1");
    expect(spec.display).toEqual({ height: 800, scale: 1, width: 1280 });
    expect(spec.tools).toEqual(["send_message", "computer", "shell", "read_file", "write_file"]);
    const raw = await fetch(`${h.url}/spec`);
    const json = (await raw.json()) as { id: string };
    expect(json.id).toBe("computer.v1");
  });

  it("iPhone can take the seat, paste, and tap I'm done", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();

    await expect(
      rpc(h.url, "/computer.v1.Seat/Pointer", { type: "click" }, token),
    ).rejects.toMatchObject({ code: "SEAT_HELD" });

    await rpc(
      h.url,
      "/computer.v1.Agent/Computer",
      { actions: [{ type: "request_takeover" }], request_id: "take" },
      h.agent,
    );

    const st = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as { state: string };
    expect(st.state).toBe("WAITING");

    const click = (await rpc(
      h.url,
      "/computer.v1.Seat/Pointer",
      { button: "left", type: "click" },
      token,
    )) as { seat: string };
    expect(click.seat).toBe("HUMAN");

    await rpc(h.url, "/computer.v1.Seat/ClipboardSet", { text: "/workspace/app" }, token);
    const clip = (await rpc(h.url, "/computer.v1.Seat/ClipboardGet", {}, token)) as {
      text: string;
    };
    expect(clip.text).toBe("/workspace/app");

    await rpc(h.url, "/computer.v1.Seat/Type", { text: "ok" }, token);
    expect(h.desk.lastType).toBe("ok");

    const done = (await rpc(h.url, "/computer.v1.Seat/SetPresence", { present: false }, token)) as {
      state: string;
    };
    expect(done.state).toBe("AGENT");

    const again = (await rpc(
      h.url,
      "/computer.v1.Agent/Computer",
      { actions: [{ type: "screenshot" }], request_id: "after" },
      h.agent,
    )) as { seat: string };
    expect(again.seat).toBe("AGENT");
  });

  it("does not expose clipboard or vncUrl as a model tool", async () => {
    const h = await startHub();
    opened.push(h);
    await expect(rpc(h.url, "/computer.v1.Seat/ClipboardGet", {}, h.agent)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, h.agent)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const eve = await fetch(`${h.url}/eve/v1/session`, {
      body: "{}",
      headers: { authorization: `Bearer ${h.agent}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(eve.status).toBe(401);
  });

  it("locks Pair after repeated bad setup codes", async () => {
    const h = await startHub();
    opened.push(h);
    for (let i = 0; i < 10; i++) {
      await expect(rpc(h.url, "/computer.v1.Seat/Pair", { code: "nope" })).rejects.toMatchObject({
        status: 401,
      });
    }
    // Even the right code is refused while the lockout holds.
    await expect(rpc(h.url, "/computer.v1.Seat/Pair", { code: h.setup })).rejects.toMatchObject({
      status: 401,
    });
  });

  it("the Pair lockout lifts after a minute", async () => {
    const h = await startHub();
    opened.push(h);
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) {
      expect(() => h.hub.auth.pair("nope", t0)).toThrow(/bad setup code/);
    }
    expect(() => h.hub.auth.pair(h.setup, t0 + 59_000)).toThrow(/too many/);
    expect(h.hub.auth.pair(h.setup, t0 + 60_001)).toHaveLength(32);
  });

  it("JSON RPC responses echo CORS so a cross-origin panel can read them", async () => {
    const h = await startHub();
    opened.push(h);

    const preflight = await fetch(`${h.url}/computer.v1.Seat/Pair`, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "connect-protocol-version",
    );
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/GET/);
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/POST/);
    expect(preflight.headers.get("access-control-allow-methods")).toMatch(/OPTIONS/);

    const pair = await fetch(`${h.url}/computer.v1.Seat/Pair`, {
      body: JSON.stringify({ code: h.setup }),
      headers: { "connect-protocol-version": "1", "content-type": "application/json" },
      method: "POST",
    });
    expect(pair.ok).toBe(true);
    expect(pair.headers.get("access-control-allow-origin")).toBe("*");
    expect(pair.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(pair.headers.get("access-control-allow-methods")).toMatch(/POST/);
    const paired = (await pair.json()) as { token: string };

    const status = await fetch(`${h.url}/computer.v1.Seat/Status`, {
      body: JSON.stringify({}),
      headers: {
        authorization: `Bearer ${paired.token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(status.ok).toBe(true);
    expect(status.headers.get("access-control-allow-origin")).toBe("*");

    const denied = await fetch(`${h.url}/computer.v1.Agent/Spec`, {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("Status reuses the same pixel token across close polls", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const first = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as {
      vnc_url: string;
      screens: { display: number; vnc_url: string }[];
    };
    const second = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as {
      vnc_url: string;
    };
    expect(first.vnc_url).toBe(second.vnc_url);
    const pix = new URL(first.vnc_url).searchParams.get("token");
    expect(pix).toBeTruthy();
    expect(pix).not.toBe(token);
    const primary = first.screens.find((s) => s.display === 1);
    expect(primary?.vnc_url).toBe(first.vnc_url);
  });

  it("pixels and websockify require a seat token", async () => {
    const h = await startHub();
    opened.push(h);
    const naked = await fetch(`${h.url}/vnc/index.html`);
    expect(naked.status).toBe(401);

    const token = await h.pair();
    const ok = await fetch(`${h.url}/vnc/index.html?token=${token}`);
    expect(ok.status).toBe(200);
    const paired = (await rpc(h.url, "/computer.v1.Seat/Pair", { code: h.setup })) as {
      vnc_url: string;
    };
    const pix = new URL(paired.vnc_url).searchParams.get("token");
    const pixOk = await fetch(`${h.url}/vnc/index.html?token=${pix}`);
    expect(pixOk.status).toBe(200);

    const denied = await new Promise<number>((resolve) => {
      const t = setTimeout(() => resolve(-1), 2000);
      const ws = new WebSocket(`${h.url.replace("http", "ws")}/websockify`);
      ws.addEventListener("error", () => {
        clearTimeout(t);
        resolve(401);
      });
      ws.addEventListener("open", () => {
        clearTimeout(t);
        ws.close();
        resolve(101);
      });
    });
    expect(denied).toBe(401);

    const allowed = await new Promise<number>((resolve) => {
      const t = setTimeout(() => resolve(-1), 2000);
      const ws = new WebSocket(`${h.url.replace("http", "ws")}/websockify?token=${token}`);
      const done = (code: number) => {
        clearTimeout(t);
        resolve(code);
      };
      ws.addEventListener("open", () => {
        ws.close();
        done(101);
      });
      ws.addEventListener("error", () => done(401));
      ws.addEventListener("close", (ev) => {
        if (ev.code === 4401) {
          done(401);
        }
      });
    });
    expect(allowed).not.toBe(401);
  });

  it("a secret reaches the clipboard over the wire and appears in no response", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const bot = h.hub.bots.primary();

    // The agent asks for a masked field.
    const { occurrence_id } = await bot.voice.send({
      kind: "secret_request",
      label: "2FA code",
      prompt: "GitHub wants your 2FA code",
    });

    const res = await fetch(`${h.url}/computer.v1.Seat/ProvideSecret`, {
      body: JSON.stringify({ occurrence_id, value: "424242" }),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("424242");

    // It landed exactly once, on the box clipboard.
    expect(h.desk.clipboard).toBe("424242");

    // And the thread the phone can read never carries it.
    const thread = await fetch(`${h.url}/computer.v1.Seat/Occurrences`, {
      body: JSON.stringify({}),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      method: "POST",
    });
    const body = await thread.text();
    expect(body).not.toContain("424242");
    expect(body).toContain("secret_request");
  });

  it("serves a WhatsApp turn's reply out of a conversation, end to end", async () => {
    let url = "";
    const eve = await replyingEve(() => url, "agent-token-test");
    opened.push(eve);
    const h = await startHub({ eveSecret: "hub-secret", eveUrls: { main: eve.url } });
    opened.push(h);
    ({ url } = h);
    const token = await h.pair();
    const channel = h.hub.channels.add({ bot: "main", id: "whatsapp-main", kind: "whatsapp" });

    const inbound = await fetch(`${h.url}/channels/whatsapp-main/message`, {
      body: JSON.stringify({
        acct: "main",
        message: "hello",
        sender: "1@s.whatsapp.net",
        token: "g@g.us",
      }),
      headers: { "content-type": "application/json", "x-channel-secret": channel.secret },
      method: "POST",
    });
    // The bridge's contract is unchanged: one POST, one `{ reply }`, built
    // by drainStream and returned synchronously.
    const answered = (await inbound.json()) as { reply: string; sent: { conversation_id: string } };
    expect(inbound.status).toBe(200);
    expect(answered.reply).toBe("on it");

    const conversation = h.hub.conversations.list().find((c) => c.route.kind === "whatsapp")!;
    expect(answered.sent.conversation_id).toBe(conversation.id);

    // The additive field: the turn's messages, oldest first, each authored
    // by the Bot, with the reply text on the last one.
    const page = (await rpc(
      h.url,
      "/computer.v1.Seat/Occurrences",
      { conversation_id: conversation.id },
      token,
    )) as { entries: { author: { kind: string }; kind: string; text?: string; seq: number }[] };
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({
      author: { bot: "main", kind: "bot" },
      kind: "text",
      seq: 1,
      text: "on it",
    });

    // And the seat thread is untouched: nothing leaked across the routes.
    const seat = (await rpc(h.url, "/computer.v1.Seat/Occurrences", {}, token)) as {
      entries: unknown[];
    };
    expect(seat.entries).toEqual([]);
  });

  it("Occurrences without a conversation_id is the seat thread, exactly as before", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    // A send with no turn binding: the eve TUI, the `/eve/v1` proxy, today.
    const sent = (await rpc(
      h.url,
      "/computer.v1.Agent/SendMessage",
      { kind: "text", text: "hi" },
      h.agent,
    )) as { conversation_id: string };
    const seatId = sent.conversation_id;
    const page = (await rpc(h.url, "/computer.v1.Seat/Occurrences", {}, token)) as {
      entries: Record<string, unknown>[];
      next_cursor: string | null;
    };
    expect(page.next_cursor).toBeNull();
    expect(page.entries).toEqual([
      {
        at: expect.any(Number),
        // Additive, and now filled in on this route too: the seat thread is
        // a conversation like any other, which is what phase 2 finished.
        author: { bot: "main", kind: "bot" },
        conversation_id: seatId,
        id: expect.any(String),
        images: [],
        kind: "text",
        seq: 1,
        text: "hi",
      },
    ]);
    // The only conversation is the Bot's own thread: nothing on this path
    // resolves a route, so nothing new was created by the send.
    expect(h.hub.conversations.list().map((c) => c.route)).toEqual([{ kind: "seat" }]);

    // A conversation id that does not exist is a refusal, not an empty page.
    await expect(
      rpc(h.url, "/computer.v1.Seat/Occurrences", { conversation_id: "conv_nope" }, token),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a send whose turn token is unknown, expired or another Bot's", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "agent-token-test" },
        { display: 2, id: "night", token: "agent-token-night" },
      ],
    });
    opened.push(h);
    const conversation = h.hub.conversations.resolve(
      "main",
      { acct: "main", jid: "g@g.us", kind: "whatsapp" },
      [{ bot: "main", kind: "bot" }],
    );
    const send = (token: string, turn: string) =>
      fetch(`${h.url}/computer.v1.Agent/SendMessage`, {
        body: JSON.stringify({ kind: "text", text: "hi" }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-computer-turn": turn,
        },
        method: "POST",
      });

    // A token the hub never minted. A Bot has no way to make one: it comes
    // off a header the ingress writes and the model never sees.
    const invented = await send("agent-token-test", "turn_invented");
    expect(invented.status).toBe(401);

    const turn = h.hub.turns.mint({ bot: "main", conversation_id: conversation.id });
    // A real one, presented by the other Bot on the box. Bots share the box
    // and are not a trust boundary there, but attribution in the record is
    // the point, so night may not speak in main's conversation.
    const wrongBot = await send("agent-token-night", turn.id);
    expect(wrongBot.status).toBe(403);
    await expect(wrongBot.json()).resolves.toMatchObject({ error: { code: "DENIED" } });

    // Past its deadline: the reply it was minted for is long gone.
    h.hub.turns.expire(turn.deadline_at + 1);
    const stale = await send("agent-token-test", turn.id);
    expect(stale.status).toBe(401);

    // Nothing was written by any of the three refusals.
    expect(h.hub.conversations.page(conversation.id).entries).toEqual([]);
    // And the same send with no turn header still lands in the seat thread.
    await rpc(h.url, "/computer.v1.Agent/SendMessage", { kind: "text", text: "hi" }, h.agent);
    expect(h.hub.bots.byId("main").voice.page().entries).toHaveLength(1);
  });

  it("lists every conversation on a screen, and only an owner may ask", async () => {
    const h = await startHub({
      bots: [
        { display: 1, id: "main", token: "agent-token-test" },
        { display: 2, id: "night", token: "agent-token-night" },
      ],
    });
    opened.push(h);
    const token = await h.pair();
    const chat = h.hub.conversations.resolve(
      "main",
      { acct: "main", jid: "g@g.us", kind: "whatsapp" },
      [
        { bot: "main", kind: "bot" },
        { kind: "human", ref: "1@s.whatsapp.net" },
      ],
    );
    h.hub.conversations.send(
      chat.id,
      { bot: "main", kind: "bot" },
      {
        images: [],
        kind: "text",
        text: "on it",
      },
    );

    const list = async (body: unknown, as: string) =>
      (await rpc(h.url, "/computer.v1.Seat/Conversations", body, as)) as {
        conversations: { id: string; route: { kind: string }; last_seq: number }[];
      };

    // An unbound owner asking for nothing sees every screen: both Bots'
    // seat threads and the one WhatsApp chat.
    const all = await list({}, token);
    const kinds = all.conversations.map((c) => c.route.kind);
    expect(kinds.filter((k) => k === "seat")).toHaveLength(2);
    expect(kinds.filter((k) => k === "whatsapp")).toHaveLength(1);
    // `last_seq` mirrors the log tail, so a picker knows there is something
    // new without paging for it.
    expect(all.conversations.find((c) => c.id === chat.id)).toMatchObject({
      last_seq: 1,
      participants: [
        { bot: "main", kind: "bot" },
        { kind: "human", ref: "1@s.whatsapp.net" },
      ],
      route: { acct: "main", jid: "g@g.us", kind: "whatsapp" },
    });
    // Naming a screen narrows it to that Bot's conversations.
    const screen2 = await list({ display: 2 }, token);
    expect(screen2.conversations.map((c) => c.route.kind)).toEqual(["seat"]);

    // A seat minted for screen 2 sees screen 2, whatever it asks for, and is
    // refused when it names another. Same containment as Occurrences: this
    // list is how a client would find a conversation id to read.
    const owner = h.hub.auth.principalFor(token)!;
    const phone = h.hub.auth.issue({ display: 2, role: "owner", subject: "phone" }, owner);
    const bound = await list({}, phone.token);
    expect(bound.conversations.map((c) => c.route.kind)).toEqual(["seat"]);
    expect(bound.conversations.some((c) => c.id === chat.id)).toBe(false);
    await expect(list({ display: 1 }, phone.token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });

    // Owner only, and for free: every narrower role is an allowlist, so a
    // Seat RPC nobody listed reaches the box's owner and nobody else.
    const viewer = h.hub.auth.issue({ role: "viewer", subject: "grace" }, owner);
    await expect(list({}, viewer.token)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("Occurrences and ProvideSecret both require a seat token", async () => {
    const h = await startHub();
    opened.push(h);
    for (const m of ["Occurrences", "ProvideSecret"]) {
      const res = await fetch(`${h.url}/computer.v1.Seat/${m}`, {
        body: JSON.stringify({}),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(401);
    }
  });

  it("JSON RPC responses include CORS headers the preflight already advertised", async () => {
    const h = await startHub();
    opened.push(h);
    const ok = await fetch(`${h.url}/computer.v1.Seat/Pair`, {
      body: JSON.stringify({ code: h.setup }),
      headers: {
        "content-type": "application/json",
        origin: "https://example.vercel.app",
      },
      method: "POST",
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("*");
    expect(ok.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(ok.headers.get("access-control-allow-headers")).toContain("content-type");
    expect(ok.headers.get("access-control-allow-headers")).toContain("connect-protocol-version");

    const denied = await fetch(`${h.url}/computer.v1.Seat/Pair`, {
      body: JSON.stringify({ code: "nope" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe("*");
    expect(denied.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("Status reuses the pixel token instead of minting every call", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const first = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as { vnc_url: string };
    const second = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as { vnc_url: string };
    expect(first.vnc_url).toBe(second.vnc_url);
    const pix = new URL(first.vnc_url).searchParams.get("token");
    expect(pix).toBeTruthy();
    expect(pix).not.toBe(token);
  });

  it("GET /healthz is public and does not leak seat state", async () => {
    const h = await startHub();
    opened.push(h);
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    // No supervisor status file in tests: the hub reports itself alone.
    expect(json).toEqual({ hub: true, ok: true });
    expect(json).not.toHaveProperty("seat");
  });
});
