import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodingService } from "../src/service/coding.ts";
import { FileCodingIntentStore } from "../src/service/coding-intents.ts";
import { ConversationRegistry } from "../src/service/conversations.ts";

describe("coding launch acknowledgement loss", () => {
  it("reconciles the same provider identity after restart and refuses changed input", async () => {
    const dir = mkdtempSync(join(tmpdir(), "coding-intents-"));
    try {
      const store = new FileCodingIntentStore(join(dir, "intents.json"));
      const conversations = new ConversationRegistry();
      const request = {
        bot: "main",
        repo: "https://github.com/mblode/expert",
        prompt: "Fix checkout",
        request_id: "request-1",
      };
      let createdId = "";
      const failed = new CodingService(
        conversations,
        "private-key",
        async (_url, init) => {
          createdId = JSON.parse(String(init.body)).agentId;
          throw new Error("response lost after create");
        },
        store,
      );
      await expect(failed.start(request)).rejects.toThrow("failed");
      expect(createdId).toMatch(/^bc-/);
      let creates = 0;
      const recovered = new CodingService(
        conversations,
        "private-key",
        async (url, init) => {
          if (init.method === "POST") {
            creates += 1;
            expect(JSON.parse(String(init.body)).agentId).toBe(createdId);
            return Response.json({ secret: "must-not-leak" }, { status: 409 });
          }
          expect(url).toContain(createdId);
          return Response.json({ id: createdId, url: `https://cursor.com/agents/${createdId}` });
        },
        new FileCodingIntentStore(join(dir, "intents.json")),
      );
      const result = await recovered.start(request);
      expect(result.agent).toBe(createdId);
      expect(await recovered.start(request)).toEqual(result);
      expect(creates).toBe(1);
      await expect(recovered.start({ ...request, prompt: "Different work" })).rejects.toThrow(
        "different coding brief",
      );
      expect(conversations.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not return provider error bodies", async () => {
    const coding = new CodingService(new ConversationRegistry(), "private-key", async () =>
      Response.json({ token: "private-provider-token" }, { status: 403 }),
    );
    await expect(
      coding.start({ bot: "main", repo: "https://github.com/mblode/expert", prompt: "test" }),
    ).rejects.toThrow("refused the request (403)");
  });
});

it("an independent poller recovers a persisted launch and reports its result once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "coding-poll-"));
  try {
    const store = new FileCodingIntentStore(join(dir, "intents.json"));
    const conversations = new ConversationRegistry();
    let agent = "";
    let finished = false;
    const provider = async (url: string, init: RequestInit) => {
      if (init.method === "POST") agent = JSON.parse(String(init.body)).agentId;
      return Response.json(
        url.includes("/runs/")
          ? {
              id: "run-one",
              status: finished ? "FINISHED" : "RUNNING",
              result: finished ? "Ready to review" : undefined,
            }
          : { id: agent, url: "https://cursor.com/agents/test", latestRunId: "run-one" },
      );
    };
    await new CodingService(conversations, "key", provider, store).start({
      bot: "main",
      repo: "https://github.com/mblode/expert",
      prompt: "test",
      request_id: "one",
      source_conversation_id: "conv_original",
    });
    finished = true;
    const completed = vi.fn().mockResolvedValue(undefined);
    await new CodingService(
      conversations,
      "key",
      provider,
      new FileCodingIntentStore(join(dir, "intents.json")),
    ).poll(completed);
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ state: "complete" }),
      "conv_original",
    );
    await new CodingService(conversations, "key", provider, store).poll(completed);
    expect(completed).toHaveBeenCalledTimes(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("persists polling backoff and waits for its due time after restart", async () => {
  const { ClockClient } = await import("../src/service/clock.ts");
  const dir = mkdtempSync(join(tmpdir(), "coding-backoff-"));
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  try {
    const store = new FileCodingIntentStore(join(dir, "intents.json"));
    const conversations = new ConversationRegistry();
    const clock = new ClockClient("http://unused", "one", "test-clock");
    const schedule = vi.spyOn(clock, "checkAt").mockResolvedValue();
    const provider = vi.fn(async (_url: string, init: RequestInit) =>
      Response.json({ id: JSON.parse(String(init.body)).agentId }),
    );
    const service = new CodingService(conversations, "test-key", provider, store, clock);
    await service.start({
      bot: "main",
      repo: "https://github.com/mblode/expert",
      prompt: "test",
      request_id: "backoff",
    });
    provider.mockRejectedValue(new Error("provider temporarily unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await service.poll(async () => {});
      expect(store.load()[0]).toMatchObject({ failures: 1, next_check_at: 1_060_000 });
      const before = provider.mock.calls.length;
      const restarted = new CodingService(conversations, "test-key", provider, store, clock);
      await restarted.poll(async () => {});
      expect(provider).toHaveBeenCalledTimes(before);
      now.mockReturnValue(1_060_000);
      await restarted.poll(async () => {});
      expect(store.load()[0]).toMatchObject({ failures: 2, next_check_at: 1_180_000 });
      expect(schedule).toHaveBeenLastCalledWith(expect.any(String), 1_180_000);
    } finally {
      warn.mockRestore();
    }
  } finally {
    now.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  }
});
