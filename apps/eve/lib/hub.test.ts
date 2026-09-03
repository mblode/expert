import { afterEach, describe, expect, it, vi } from "vitest";
import { hubRpc } from "./hub.ts";

describe("hubRpc", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  /** A reachable hub that answers one canned response. */
  const withHub = (response: Response) => {
    vi.stubEnv("COMPUTER_BOT_TOKEN", "bot_token");
    vi.stubEnv("COMPUTER_URL", "http://127.0.0.1:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );
  };

  it("refuses to call the hub at all without a Bot token", async () => {
    vi.stubEnv("COMPUTER_BOT_TOKEN", "");
    await expect(hubRpc("shell", {})).rejects.toThrow(/COMPUTER_BOT_TOKEN is not set/u);
  });

  it("surfaces the hub's own error envelope", async () => {
    withHub(
      Response.json(
        { error: { code: "SEAT_HELD", message: "human has the seat" } },
        { status: 409 },
      ),
    );
    await expect(hubRpc("shell", {})).rejects.toThrow("SEAT_HELD: human has the seat");
  });

  it("still says something when the failure carries no body at all", async () => {
    // The fallback used to sit behind `??`, which `String.slice` can never
    // reach, so a bodyless 5xx threw `HTTP_503: ` and named nothing.
    withHub(new Response("", { status: 503 }));
    await expect(hubRpc("shell", {})).rejects.toThrow("HTTP_503: hub call failed");
  });
});
