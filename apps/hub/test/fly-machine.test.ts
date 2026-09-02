import { describe, expect, it } from "vitest";
import {
  guestState,
  machinePath,
  methodFor,
  resolveFlyConfig,
  flyRequest,
} from "../src/host/fly-machine.ts";

describe("fly-machine", () => {
  it("maps sleep to stop and wake to start", () => {
    expect(machinePath("box", "d8", "sleep")).toBe("/v1/apps/box/machines/d8/stop");
    expect(machinePath("box", "d8", "wake")).toBe("/v1/apps/box/machines/d8/start");
    expect(machinePath("box", "d8", "suspend")).toBe("/v1/apps/box/machines/d8/suspend");
    expect(methodFor("sleep")).toBe("POST");
    expect(methodFor("status")).toBe("GET");
    expect(methodFor("list")).toBe("GET");
  });

  it("maps Fly states onto the Grok-shaped guest words", () => {
    expect(guestState("started")).toBe("running");
    expect(guestState("suspended")).toBe("hibernated");
    expect(guestState("stopped")).toBe("stopped");
    expect(guestState("starting")).toBe("starting");
  });

  it("reads app/machine from the environment without inventing a token", () => {
    const cfg = resolveFlyConfig({
      FLY_API_TOKEN: "tok",
      FLY_APP_NAME: "computer",
      FLY_MACHINE_ID: "1850deadbeef",
    });
    expect(cfg.token).toBe("tok");
    expect(cfg.app).toBe("computer");
    expect(cfg.machine).toBe("1850deadbeef");
    expect(cfg.api).toBe("https://api.machines.dev");
  });

  it("wakes by POSTing /start and picks the only Machine when unset", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetch = async (url: string, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? "GET", url });
      if (url.endsWith("/machines")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify([{ id: "m1", state: "stopped" }]),
        };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    };
    const { machine } = await flyRequest("wake", {
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer" },
      fetch,
    });
    expect(machine).toBe("m1");
    expect(calls[0]).toEqual({
      method: "GET",
      url: "https://api.machines.dev/v1/apps/computer/machines",
    });
    expect(calls[1]).toEqual({
      method: "POST",
      url: "https://api.machines.dev/v1/apps/computer/machines/m1/start",
    });
  });

  it("sleeps by POSTing /stop", async () => {
    const fetch = async (url: string) => {
      expect(url).toBe("https://api.machines.dev/v1/apps/computer/machines/m1/stop");
      return { ok: true, status: 200, text: async () => "{}" };
    };
    await flyRequest("sleep", {
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "computer", FLY_MACHINE_ID: "m1" },
      fetch,
    });
  });
});
