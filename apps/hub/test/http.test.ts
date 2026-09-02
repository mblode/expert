import { afterEach, describe, expect, it } from "vitest";
import { rpc, startHub } from "./helper.ts";

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
    expect(json).toEqual({ ok: true });
    expect(json).not.toHaveProperty("seat");
  });
});
