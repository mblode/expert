import { afterEach, describe, expect, it, vi } from "vitest";

import { bridgeGet } from "./bridge-client.ts";

import { fetchLiveMembers } from "./live-members.js";

type AsyncStub = (...args: never[]) => Promise<unknown>;

vi.mock(import("./bridge-client.ts"), () => ({
  bridgeConfigured: () => Boolean(process.env.BRIDGE_URL),
  bridgeGet: vi.fn<AsyncStub>() as unknown as typeof bridgeGet,
}));

describe(fetchLiveMembers, () => {
  afterEach(() => {
    delete process.env.BRIDGE_URL;
    delete process.env.WHATSAPP_BRIDGE_SECRET;
    vi.mocked(bridgeGet).mockReset();
  });

  it("returns null when the bridge is unconfigured", async () => {
    await expect(fetchLiveMembers()).resolves.toBeNull();
    expect(bridgeGet).not.toHaveBeenCalled();
  });

  it("returns null when the live set is not yet ready", async () => {
    process.env.BRIDGE_URL = "https://bridge.example";
    process.env.WHATSAPP_BRIDGE_SECRET = "s";
    vi.mocked(bridgeGet).mockResolvedValue({
      members: [],
      ready: false,
    });
    await expect(fetchLiveMembers()).resolves.toBeNull();
  });

  it("returns the live list when the bridge is ready", async () => {
    process.env.BRIDGE_URL = "https://bridge.example";
    process.env.WHATSAPP_BRIDGE_SECRET = "s";
    const members = [{ name: "Finlay", phone: "+61411111111", tags: ["unidentified"] }];
    vi.mocked(bridgeGet).mockResolvedValue({ members, ready: true });
    await expect(fetchLiveMembers()).resolves.toStrictEqual(members);
  });

  it("returns null when the bridge call fails", async () => {
    process.env.BRIDGE_URL = "https://bridge.example";
    process.env.WHATSAPP_BRIDGE_SECRET = "s";
    vi.mocked(bridgeGet).mockRejectedValue(new Error("down"));
    await expect(fetchLiveMembers()).resolves.toBeNull();
  });
});
