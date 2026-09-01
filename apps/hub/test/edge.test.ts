import { describe, expect, it } from "vitest";
import {
  edgeDecide,
  hibernatedBody,
  maybeIdleSuspend,
  pickComputerMachine,
  shouldWake,
} from "../src/host/edge.ts";

describe("edge cold paths", () => {
  it("does not wake on Status, roster, or health", () => {
    expect(shouldWake("/computer.v1.Seat/Status")).toBe(false);
    expect(shouldWake("/roster")).toBe(false);
    expect(shouldWake("/healthz")).toBe(false);
    expect(shouldWake("/cold/status")).toBe(false);
  });

  it("wakes on VNC, Pair, and Agent use", () => {
    expect(shouldWake("/vnc/index.html")).toBe(true);
    expect(shouldWake("/websockify")).toBe(true);
    expect(shouldWake("/computer.v1.Seat/Pair")).toBe(true);
    expect(shouldWake("/computer.v1.Agent/Computer")).toBe(true);
  });

  it("picks the computer process group out of edge+guest", () => {
    const guest = pickComputerMachine([
      { id: "edge1", state: "started", config: { metadata: { fly_process_group: "edge" } } },
      {
        id: "box1",
        state: "suspended",
        private_ip: "fdaa:1",
        config: { metadata: { fly_process_group: "computer" } },
      },
    ]);
    expect(guest?.id).toBe("box1");
    expect(guest?.state).toBe("suspended");
  });

  it("Status against a suspended guest is cold and never POSTs /start", async () => {
    const calls: string[] = [];
    const fetch = async (url: string, init?: { method?: string }) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            {
              id: "box1",
              state: "suspended",
              config: { metadata: { fly_process_group: "computer" } },
            },
          ]),
      };
    };
    const d = await edgeDecide("/computer.v1.Seat/Status", {
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer" },
      fetch,
    });
    expect(d.action).toBe("cold");
    expect(d.guestState).toBe("hibernated");
    expect(calls.some((c) => c.includes("/start"))).toBe(false);
    const body = hibernatedBody() as { error: { reason: string } };
    expect(body.error.reason).toBe("hibernated");
  });

  it("VNC against a suspended guest is wake", async () => {
    const fetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          { id: "box1", state: "suspended", config: { metadata: { fly_process_group: "computer" } } },
        ]),
    });
    const d = await edgeDecide("/websockify", {
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer" },
      fetch,
    });
    expect(d.action).toBe("wake");
  });

  it("idle suspend waits minutes, not 30 seconds", async () => {
    const stamp = { t: 0 };
    let suspended = false;
    const did = await maybeIdleSuspend(stamp, {
      guestId: "box1",
      idleSuspendMs: 20 * 60 * 1000,
      now: () => 30_000,
      suspendGuest: async () => {
        suspended = true;
      },
    });
    expect(did).toBe(false);
    expect(suspended).toBe(false);
    const later = await maybeIdleSuspend(stamp, {
      guestId: "box1",
      idleSuspendMs: 20 * 60 * 1000,
      now: () => 21 * 60 * 1000,
      suspendGuest: async () => {
        suspended = true;
      },
    });
    expect(later).toBe(true);
    expect(suspended).toBe(true);
  });
});
