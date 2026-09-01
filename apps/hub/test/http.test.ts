import { afterEach, describe, expect, it } from "vitest";
import { rpc, startHub } from "./helper.ts";

const opened: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  while (opened.length) await opened.pop()?.close();
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
    expect(res.vnc_url).toContain(`token=${res.token}`);
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
    expect(spec.display).toEqual({ width: 1280, height: 800, scale: 1 });
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
      { request_id: "take", actions: [{ type: "request_takeover" }] },
      h.agent,
    );

    const st = (await rpc(h.url, "/computer.v1.Seat/Status", {}, token)) as { state: string };
    expect(st.state).toBe("WAITING");

    const click = (await rpc(
      h.url,
      "/computer.v1.Seat/Pointer",
      { type: "click", button: "left" },
      token,
    )) as { seat: string };
    expect(click.seat).toBe("HUMAN");

    await rpc(h.url, "/computer.v1.Seat/ClipboardSet", { text: "/workspace/app" }, token);
    const clip = (await rpc(h.url, "/computer.v1.Seat/ClipboardGet", {}, token)) as { text: string };
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
      { request_id: "after", actions: [{ type: "screenshot" }] },
      h.agent,
    )) as { seat: string };
    expect(again.seat).toBe("AGENT");
  });

  it("does not expose clipboard or vncUrl as a model tool", async () => {
    const h = await startHub();
    opened.push(h);
    await expect(
      rpc(h.url, "/computer.v1.Seat/ClipboardGet", {}, h.agent),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(rpc(h.url, "/computer.v1.Seat/Status", {}, h.agent)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const chat = await fetch(`${h.url}/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.agent}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    expect(chat.status).toBe(401);
  });

  it("pixels and websockify require a seat token", async () => {
    const h = await startHub();
    opened.push(h);
    const naked = await fetch(`${h.url}/vnc/index.html`);
    expect(naked.status).toBe(401);
    const debug = await fetch(`${h.url}/`);
    expect(debug.status).toBe(401);

    const token = await h.pair();
    const ok = await fetch(`${h.url}/vnc/index.html?token=${token}`);
    expect(ok.status).toBe(200);

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
        if (ev.code === 4401) done(401);
      });
    });
    expect(allowed).not.toBe(401);
  });

  it("chat stream works with a seat token and can request takeover", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const res = await fetch(`${h.url}/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "open computer" }),
    });
    expect(res.ok).toBe(true);
    const text = await res.text();
    expect(text).toContain("waiting");
    expect(h.hub.bots.primary().seat.getState()).toBe("WAITING");
  });

  it("the chat stream carries occurrences, never raw model prose", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const res = await fetch(`${h.url}/chat`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ message: "what can you do" }),
    });
    const text = await res.text();
    const events = text
      .split("\n\n")
      .filter((b) => b.startsWith("data: "))
      .map((b) => JSON.parse(b.slice(6)) as { type: string; occurrence?: { kind: string; text?: string } });

    // The old shape is gone: nothing reaches the phone as a raw delta.
    expect(events.some((e) => e.type === "delta")).toBe(false);

    // The human's own message is the first occurrence, then the reply.
    const kinds = events.filter((e) => e.type === "occurrence").map((e) => e.occurrence!.kind);
    expect(kinds[0]).toBe("human");
    expect(kinds).toContain("text");

    // And the log is the same one the voice keeps, so the thread persists.
    const log = h.hub.bots.primary().voice.page().entries;
    expect(log.map((o) => o.kind)).toEqual(kinds);
  });

  it("a secret reaches the clipboard over the wire and appears in no response", async () => {
    const h = await startHub();
    opened.push(h);
    const token = await h.pair();
    const bot = h.hub.bots.primary();

    // The agent asks for a masked field.
    const { occurrence_id } = await bot.voice.send({
      kind: "secret_request",
      prompt: "GitHub wants your 2FA code",
      label: "2FA code",
    });

    const res = await fetch(`${h.url}/computer.v1.Seat/ProvideSecret`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ occurrence_id, value: "424242" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("424242");

    // It landed exactly once, on the box clipboard.
    expect(h.desk.clipboard).toBe("424242");

    // And the thread the phone can read never carries it.
    const thread = await fetch(`${h.url}/computer.v1.Seat/Occurrences`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const body = await thread.text();
    expect(body).not.toContain("424242");
    expect(body).toContain("secret_request");
  });

  it("Occurrences and ProvideSecret both require a seat token", async () => {
    const h = await startHub();
    opened.push(h);
    for (const m of ["Occurrences", "ProvideSecret"]) {
      const res = await fetch(`${h.url}/computer.v1.Seat/${m}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(401);
    }
  });

  it("GET /healthz is public and does not leak seat state", async () => {
    const h = await startHub();
    opened.push(h);
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json).toEqual({ ok: true });
    expect(json).not.toHaveProperty("seat");
  });
});
