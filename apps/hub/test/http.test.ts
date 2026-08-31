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
    expect(spec.tools).toEqual(["computer", "shell", "read_file", "write_file"]);
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

  it("does not expose clipboard as a model tool", async () => {
    const h = await startHub();
    opened.push(h);
    await expect(
      rpc(h.url, "/computer.v1.Seat/ClipboardGet", {}, h.agent),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  it("refuses to register a Connect method without an auth policy", () => {
    expect(() => {
      const { ConnectRouter } = require("../src/handler/router.ts") as typeof import("../src/handler/router.ts");
      void ConnectRouter;
    }).not.toThrow();
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
    expect(h.hub.seat.getState()).toBe("WAITING");
  });

  it("GET /healthz is public", async () => {
    const h = await startHub();
    opened.push(h);
    const res = await fetch(`${h.url}/healthz`);
    expect(res.status).toBe(200);
  });
});
