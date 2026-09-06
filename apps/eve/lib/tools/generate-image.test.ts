import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import generateImageTool from "./generate-image.ts";

// The model call is mocked out: these tests cover the tool's gating and
// delivery wiring, not generation. The happy path stubs a tiny generated image
// and asserts it's shipped to the bridge's /send-media. gateway.image() only
// constructs a model handle (no IO), so the gateway stays real.
interface FakeImage {
  image: { base64: string; mediaType: string };
}
vi.mock(import("ai"), async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    generateImage: vi.fn<() => Promise<FakeImage>>(() =>
      Promise.resolve({ image: { base64: "aGk=", mediaType: "image/png" } }),
    ) as unknown as typeof mod.generateImage,
  };
});

// Off-bridge context (no BRIDGE_URL / secret), the way the eve TUI runs.
const offBridgeCtx = { session: { auth: { current: undefined } } } as never;

const groupCtx = {
  session: {
    auth: { current: { attributes: { groupJid: "123@g.us" } } },
  },
} as never;

describe("generate-image", () => {
  beforeEach(() => {
    process.env.BRIDGE_URL = "http://bridge.test";
    process.env.WHATSAPP_BRIDGE_SECRET = "secret";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BRIDGE_URL;
    delete process.env.WHATSAPP_BRIDGE_SECRET;
  });

  it("degrades gracefully off-group / without the bridge", async () => {
    delete process.env.BRIDGE_URL;
    delete process.env.WHATSAPP_BRIDGE_SECRET;
    const res = (await generateImageTool.execute(
      { prompt: "a cyberpunk kangaroo" },
      offBridgeCtx,
    )) as { available?: boolean; sent?: boolean };
    expect(res.available).toBeFalsy();
    expect(res.sent).toBeFalsy();
  });

  it("delivers the generated image to the bridge's /send-media", async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>((url, init) => {
      expect(url).toBe("http://bridge.test/send-media");
      const body = JSON.parse(init.body as string);
      expect(body).toMatchObject({
        base64: "aGk=",
        jid: "123@g.us",
        mime: "image/png",
      });
      return Promise.resolve({
        json: () => Promise.resolve({ sent: true }),
        ok: true,
      } as Response);
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = (await generateImageTool.execute({ prompt: "a cyberpunk kangaroo" }, groupCtx)) as {
      sent?: boolean;
    };
    expect(res.sent).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports a failed delivery instead of throwing", async () => {
    // A 403 (not allowlisted / daily cap) fails fast, no retry.
    const fetchMock = vi.fn<() => Promise<Response>>(() =>
      Promise.resolve({ ok: false, status: 403 } as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    const res = (await generateImageTool.execute({ prompt: "a cyberpunk kangaroo" }, groupCtx)) as {
      sent?: boolean;
      error?: string;
    };
    expect(res.sent).toBeFalsy();
    expect(res.error).toContain("403");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
