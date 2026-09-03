import { describe, expect, it } from "vitest";
import {
  appsPath,
  guestState,
  machinePath,
  methodFor,
  resolveFlyConfig,
  flyRequest,
  volumesPath,
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

  it("maps create onto the collection and destroy onto DELETE", () => {
    expect(machinePath("box", "", "create")).toBe("/v1/apps/box/machines");
    expect(machinePath("box", "d8", "destroy")).toBe("/v1/apps/box/machines/d8");
    expect(methodFor("create")).toBe("POST");
    expect(methodFor("destroy")).toBe("DELETE");
    expect(appsPath()).toBe("/v1/apps");
    expect(appsPath("box")).toBe("/v1/apps/box");
    expect(volumesPath("box")).toBe("/v1/apps/box/volumes");
    expect(volumesPath("box", "vol_1")).toBe("/v1/apps/box/volumes/vol_1");
  });

  it("creates without first discovering a Machine, and sends the payload", async () => {
    // A create has no Machine to find; the discovery branch would list an app
    // that has none and throw "no Machines in this app: fly deploy first".
    const calls: { url: string; method?: string; body?: string }[] = [];
    const res = await flyRequest("create", {
      env: { FLY_API_TOKEN: "tok", FLY_APP_NAME: "box" },
      fetch: async (url, init) => {
        calls.push({ body: init?.body, method: init?.method, url });
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: "d8" }) };
      },
      payload: { config: { image: "img" } },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.machines.dev/v1/apps/box/machines");
    expect(calls[0]?.method).toBe("POST");
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ config: { image: "img" } });
    expect(res.body).toEqual({ id: "d8" });
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
