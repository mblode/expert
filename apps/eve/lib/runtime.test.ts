import { afterEach, describe, expect, it, vi } from "vitest";
import { runtimeInstructions } from "./runtime.ts";
import { hubRpc } from "./hub.ts";

vi.mock("./hub.ts", () => ({ hubRpc: vi.fn() }));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("memory at a turn boundary", () => {
  it("reads the supervisor-selected bot's current notes on every turn", async () => {
    vi.stubEnv("COMPUTER_BOT_ID", "main");
    vi.mocked(hubRpc)
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ content: "- (2026-09-05) [note] alpha" })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ content: "- (2026-09-05) [note] beta" });
    const first = await runtimeInstructions();
    expect(first?.content).toContain("alpha");
    const next = await runtimeInstructions();
    expect(next?.content).toContain("beta");
    expect(next?.content).not.toContain("alpha");
    expect(hubRpc).toHaveBeenCalledWith("readFile", {
      path: "/workspace/.bots/main/memory/profile.md",
    });
  });
  it("does not turn an invalid bot id into a filesystem path", async () => {
    vi.stubEnv("COMPUTER_BOT_ID", "../other");
    expect(await runtimeInstructions()).toBeNull();
    expect(hubRpc).not.toHaveBeenCalled();
  });
});

it("uses approved memory and procedures without reading model-writable fallback notes", async () => {
  vi.stubEnv("COMPUTER_BOT_ID", "main");
  vi.mocked(hubRpc).mockResolvedValue({
    runtime: {
      revision: 3,
      memory_set: true,
      memory: ["Use Melbourne time"],
      instructions: "Keep replies short",
      skills: [{ id: "review", description: "Review code", markdown: "Read tests first" }],
    },
  });
  const current = await runtimeInstructions();
  expect(current?.content).toContain("revision: 3");
  expect(current?.content).toContain("Read tests first");
  expect(current?.content).toContain("Use Melbourne time");
  expect(hubRpc).toHaveBeenCalledTimes(1);
});
