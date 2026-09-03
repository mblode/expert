import { describe, expect, it } from "vitest";
import {
  assertNoSecrets,
  createComputer,
  destroyComputer,
  machineConfig,
  PROCESS_GROUP,
  WORKSPACE_PATH,
} from "../src/host/fly-provision.ts";
import type { ComputerSpec } from "../src/host/fly-provision.ts";

const spec: ComputerSpec = {
  app: "acme-computer",
  image: "registry.fly.io/acme-computer:deployment-1",
  org: "personal",
  region: "syd",
};

/** A fetch that records calls and answers each with the queued body. */
const recorder = (bodies: unknown[]) => {
  const calls: { url: string; method?: string; payload: unknown }[] = [];
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({
      method: init?.method,
      payload: init?.body ? JSON.parse(init.body) : undefined,
      url,
    });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(bodies[calls.length - 1] ?? {}),
    };
  };
  return { calls, fetch };
};

describe("fly-provision", () => {
  it("refuses a credential in the Machine config", () => {
    // config.env reads back out of GET /machines/<id>; a Fly secret does not.
    expect(() => assertNoSecrets({ COMPUTER_SETUP_CODE: "hunter2" })).toThrow(
      /must be set as a Fly app secret/u,
    );
    expect(() => assertNoSecrets({ WHATSAPP_BRIDGE_SECRET: "s" })).toThrow(/app secret/u);
    expect(() => assertNoSecrets({ FLY_API_TOKEN: "t" })).toThrow(/app secret/u);
    expect(() => assertNoSecrets({ COMPUTER_DESK: "local" })).not.toThrow();
    expect(() => machineConfig({ ...spec, env: { FLY_API_TOKEN: "t" } }, "vol_1")).toThrow(
      /app secret/u,
    );
  });

  it("carries the process group the wake path looks for", () => {
    // fly-machine.ts finds the guest by config.metadata.fly_process_group when
    // FLY_MACHINE_ID is unset. A Machine created without it cannot be woken.
    const config = machineConfig(spec, "vol_1") as {
      metadata: Record<string, string>;
      mounts: { path: string; volume: string }[];
      services: { autostart: boolean; autostop: string }[];
    };
    expect(config.metadata.fly_process_group).toBe(PROCESS_GROUP);
    expect(config.mounts).toEqual([{ path: WORKSPACE_PATH, volume: "vol_1" }]);
    // autostart is what lets an inbound request resume a suspended tenant.
    expect(config.services[0]?.autostart).toBe(true);
    expect(config.services[0]?.autostop).toBe("suspend");
  });

  it("lets a WhatsApp tenant turn suspend off without touching the rest", () => {
    const config = machineConfig({ ...spec, autostop: "off" }, "vol_1") as {
      services: { autostop: string }[];
    };
    expect(config.services[0]?.autostop).toBe("off");
  });

  it("creates app, volume and Machine in that order and returns the hostname", async () => {
    const { calls, fetch } = recorder([{ name: "acme-computer" }, { id: "vol_1" }, { id: "d8" }]);
    const created = await createComputer(spec, { env: { FLY_API_TOKEN: "tok" }, fetch });

    expect(calls.map((c) => c.url)).toEqual([
      "https://api.machines.dev/v1/apps",
      "https://api.machines.dev/v1/apps/acme-computer/volumes",
      "https://api.machines.dev/v1/apps/acme-computer/machines",
    ]);
    expect(calls[0]?.payload).toEqual({ app_name: "acme-computer", org_slug: "personal" });
    const volumeCall = calls[1]?.payload as { region: string };
    const machineCall = calls[2]?.payload as {
      region: string;
      config: { mounts: { path: string; volume: string }[] };
    };
    // The volume and the Machine must land in the same region: volumes do not move.
    expect(volumeCall.region).toBe("syd");
    expect(machineCall.region).toBe("syd");
    // The Machine mounts the volume that was just created, not a name.
    expect(machineCall.config.mounts).toEqual([{ path: WORKSPACE_PATH, volume: "vol_1" }]);
    expect(created).toEqual({
      app: "acme-computer",
      hubUrl: "https://acme-computer.fly.dev",
      machineId: "d8",
      volumeId: "vol_1",
    });
  });

  it("fails loudly when Fly answers a create with no id", async () => {
    const { fetch } = recorder([{ name: "acme-computer" }, {}]);
    await expect(createComputer(spec, { env: { FLY_API_TOKEN: "tok" }, fetch })).rejects.toThrow(
      /no volume/u,
    );
  });

  it("destroys the app, and treats an app that is already gone as done", async () => {
    const calls: { url: string; method?: string }[] = [];
    await destroyComputer("acme-computer", {
      env: { FLY_API_TOKEN: "tok" },
      fetch: async (url, init) => {
        calls.push({ method: init?.method, url });
        return { ok: true, status: 202, text: async () => "" };
      },
    });
    expect(calls).toEqual([
      { method: "DELETE", url: "https://api.machines.dev/v1/apps/acme-computer" },
    ]);

    // Retrying a teardown must not throw, or a half-deleted tenant can never
    // be cleaned up.
    await expect(
      destroyComputer("acme-computer", {
        env: { FLY_API_TOKEN: "tok" },
        fetch: async () => ({
          ok: false,
          status: 404,
          text: async () => JSON.stringify({ error: "app not found" }),
        }),
      }),
    ).resolves.toBeUndefined();

    // Anything else still surfaces: a 403 is a token problem, not a done job.
    await expect(
      destroyComputer("acme-computer", {
        env: { FLY_API_TOKEN: "tok" },
        fetch: async () => ({
          ok: false,
          status: 403,
          text: async () => JSON.stringify({ error: "forbidden" }),
        }),
      }),
    ).rejects.toThrow(/403/u);
  });
});
