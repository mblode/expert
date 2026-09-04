import { afterEach, describe, expect, it, vi } from "vitest";
import identity from "./identity.ts";

/**
 * The one thing that makes a made Bot itself. Everything the settings sheet
 * and a shared template write ends up on the box, and this is the only path
 * by which any of it reaches a turn, so what matters is that it arrives and
 * that a hub which cannot answer costs the Bot nothing.
 */
describe("a Bot's identity in its prompt", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const withHub = (response: Response) => {
    vi.stubEnv("COMPUTER_BOT_TOKEN", "bot_token");
    vi.stubEnv("COMPUTER_URL", "http://127.0.0.1:8080");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(response)),
    );
  };

  const resolve = async () => {
    const started = identity.events?.["turn.started"];
    if (!started) {
      throw new Error("identity has no turn.started resolver");
    }
    return await started({} as never, {} as never);
  };

  it("folds what the computer says this Bot is into the turn", async () => {
    withHub(Response.json({ prompt: "You are Chief of Staff, personal ops." }));
    const resolved = await resolve();
    expect(JSON.stringify(resolved)).toContain("You are Chief of Staff, personal ops.");
  });

  it("contributes nothing when the Bot has no identity on the box", async () => {
    withHub(Response.json({ prompt: "   " }));
    expect(await resolve()).toBeNull();
  });

  /** An older hub, or one that is still waking: the project's own brief stands. */
  it("contributes nothing rather than failing the turn when the hub will not answer", async () => {
    withHub(new Response("", { status: 503 }));
    expect(await resolve()).toBeNull();
  });
});
