import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as BridgeClient from "./bridge-client.ts";

const { bridgePost } = vi.hoisted(() => ({
  bridgePost: vi.fn<(...args: never[]) => Promise<unknown>>(),
}));

vi.mock(import("./bridge-client.ts"), () => ({
  bridgeConfigured: () => Boolean(process.env.BRIDGE_URL),
  bridgePost: bridgePost as unknown as typeof BridgeClient.bridgePost,
}));

const { alertMaintainer } = await import("./alert.js");

describe(alertMaintainer, () => {
  beforeEach(() => {
    bridgePost.mockReset();
    bridgePost.mockResolvedValue({});
    process.env.BRIDGE_URL = "https://bridge.test";
  });

  afterEach(() => {
    Reflect.deleteProperty(process.env, "MEMORY_ALERT_JID");
  });

  it("DMs the maintainer by default", async () => {
    await alertMaintainer({ dedupeKey: "k", headline: "it broke" });

    expect(bridgePost.mock.calls[0][0]).toBe("/send");
    expect(bridgePost.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "k",
      jid: "61456455551@s.whatsapp.net",
      text: "it broke",
    });
  });

  it("defaults to a DM, never a group", async () => {
    // @vibey announcing its own failures to 100 people would be worse than the
    // failure. POST /send refuses group JIDs as a backstop, but the default
    // must be right without leaning on it.
    await alertMaintainer({ dedupeKey: "k", headline: "x" });

    const { jid } = bridgePost.mock.calls[0][1] as { jid: string };
    expect(jid.endsWith("@g.us")).toBeFalsy();
    expect(jid).toBe("61456455551@s.whatsapp.net");
  });

  it("carries a dedupe key so a replayed cron does not text twice", async () => {
    // Vercel is explicit that a scheduled run can be delivered more than once.
    await alertMaintainer({
      dedupeKey: "memfail#error#2026-08-05",
      headline: "x",
    });

    expect(bridgePost.mock.calls[0][1]).toMatchObject({
      idempotencyKey: "memfail#error#2026-08-05",
    });
  });

  it("clips a long detail rather than pasting a stack into a chat", async () => {
    await alertMaintainer({
      dedupeKey: "k",
      detail: "x".repeat(5000),
      headline: "boom",
    });

    const { text } = bridgePost.mock.calls[0][1] as { text: string };
    expect(text.length).toBeLessThan(1500);
    expect(text).toContain("truncated");
  });

  it("never throws when delivery fails", async () => {
    // The caller is already in a failure path. Throwing here would replace a
    // useful error with a delivery error and lose the original.
    bridgePost.mockRejectedValue(new Error("bridge down"));

    await expect(alertMaintainer({ dedupeKey: "k", headline: "x" })).resolves.toBeFalsy();
  });

  it("stays quiet with no bridge configured", async () => {
    Reflect.deleteProperty(process.env, "BRIDGE_URL");

    await expect(alertMaintainer({ dedupeKey: "k", headline: "x" })).resolves.toBeFalsy();
    expect(bridgePost).not.toHaveBeenCalled();
  });
});
