import { afterEach, describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import { CodingService, codingConfigFromEnv } from "../src/service/coding.ts";
import type { CodingConfig, CodingSession, FetchLike } from "../src/service/coding.ts";
import {
  ConversationRegistry,
  MemoryConversationStore,
  MemoryMessageLog,
} from "../src/service/conversations.ts";
import { rpc, startHub } from "./helper.ts";

const CONFIG: CodingConfig = { apiKey: "k", endpoint: "https://runner.test", timeoutMs: 1000 };
const REPO = "https://github.com/mblode/expert";

const registry = (): ConversationRegistry =>
  new ConversationRegistry(new MemoryConversationStore(), new MemoryMessageLog());

/** One canned JSON answer per call, in order, with the requests recorded. */
function runner(replies: unknown[]): { fetch: FetchLike; calls: { url: string; body?: string }[] } {
  const calls: { url: string; body?: string }[] = [];
  let i = 0;
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, ...(typeof init.body === "string" ? { body: init.body } : {}) });
      const payload = replies[Math.min(i, replies.length - 1)];
      i += 1;
      return Response.json(payload);
    },
  };
}

const agent = (extra: Record<string, unknown> = {}) => ({
  id: "bc-1",
  latestRunId: "run-1",
  url: "https://cursor.com/agents/bc-1",
  ...extra,
});

const run = (status: string, extra: Record<string, unknown> = {}) => ({
  agentId: "bc-1",
  id: "run-1",
  status,
  ...extra,
});

const text = (conv: ConversationRegistry, id: string): string[] =>
  conv
    .page(id)
    .entries.filter((e) => e.kind === "text")
    .map((e) => (e as { text: string }).text);

describe("coding sessions", () => {
  it("launches against the runner and records the ask in a code conversation", async () => {
    const conv = registry();
    const net = runner([{ agent: agent(), run: run("CREATING") }]);
    const coding = new CodingService(conv, CONFIG, net.fetch);

    const session: CodingSession = await coding.start({
      bot: "main",
      prompt: "fix the flaky test",
      repo: REPO,
    });

    expect(net.calls[0]?.url).toBe("https://runner.test/v1/agents");
    expect(JSON.parse(net.calls[0]?.body ?? "{}")).toMatchObject({
      prompt: { text: "fix the flaky test" },
      repos: [{ url: REPO }],
    });
    expect(session.state).toBe("pending");
    expect(session.agent).toBe("bc-1");

    const record = conv.byId(session.conversation_id);
    expect(record.route).toEqual({ agent: "bc-1", kind: "code", repo: REPO });
    // The person's words are the person's, and the status is the hub's.
    const { entries } = conv.page(record.id);
    expect(entries[0]).toMatchObject({ author: { kind: "human" }, kind: "human" });
    expect(entries[1]).toMatchObject({ author: { kind: "system" }, kind: "text" });
  });

  it("gives two sessions on one repository two threads", async () => {
    const conv = registry();
    const net = runner([
      { agent: agent({ id: "bc-1" }), run: run("RUNNING") },
      { agent: agent({ id: "bc-2" }), run: { ...run("RUNNING"), agentId: "bc-2" } },
    ]);
    const coding = new CodingService(conv, CONFIG, net.fetch);

    const first = await coding.start({ bot: "main", prompt: "one", repo: REPO });
    const second = await coding.start({ bot: "main", prompt: "two", repo: REPO });

    expect(second.conversation_id).not.toBe(first.conversation_id);
    expect(conv.list()).toHaveLength(2);
  });

  it("appends a line only when the state moved, so polling is free", async () => {
    const conv = registry();
    const net = runner([{ agent: agent(), run: run("RUNNING") }]);
    const coding = new CodingService(conv, CONFIG, net.fetch);
    const started = await coding.start({ bot: "main", prompt: "go", repo: REPO });
    expect(text(conv, started.conversation_id)).toHaveLength(1);

    // Two refreshes on an unchanged run: the tail already says this.
    await coding.refresh(started.conversation_id);
    await coding.refresh(started.conversation_id);
    expect(text(conv, started.conversation_id)).toHaveLength(1);
  });

  it("records the branch and the pull request when the run finishes", async () => {
    const conv = registry();
    const finished = run("FINISHED", {
      git: {
        branches: [
          {
            branch: "cursor/fix-flake",
            prUrl: "https://github.com/mblode/expert/pull/7",
            repoUrl: "github.com/mblode/expert",
          },
        ],
      },
      result: "Fixed the flake and added a regression test.",
    });
    const net = runner([{ agent: agent(), run: run("RUNNING") }, agent(), finished]);
    const coding = new CodingService(conv, CONFIG, net.fetch);
    const started = await coding.start({ bot: "main", prompt: "go", repo: REPO });

    const done = await coding.refresh(started.conversation_id);

    expect(done.state).toBe("complete");
    expect(done.branch).toBe("cursor/fix-flake");
    expect(done.pr_url).toBe("https://github.com/mblode/expert/pull/7");
    const lines = text(conv, started.conversation_id);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("https://github.com/mblode/expert/pull/7");
    expect(lines[1]).toContain("cursor/fix-flake");
  });

  it("reads cancelled and expired as the same stale, and an unknown state as pending", async () => {
    const conv = registry();
    for (const [status, state] of [
      ["CANCELLED", "stale"],
      ["EXPIRED", "stale"],
      ["SOMETHING_NEW", "pending"],
      ["ERROR", "error"],
    ] as const) {
      const net = runner([{ agent: agent(), run: run(status) }]);
      const coding = new CodingService(registry(), CONFIG, net.fetch);
      const session = await coding.start({ bot: "main", prompt: "go", repo: REPO });
      expect(session.state).toBe(state);
    }
    expect(conv.list()).toHaveLength(0);
  });

  it("refuses a repository that is not a GitHub URL before it calls anything", async () => {
    const conv = registry();
    const net = runner([{ agent: agent() }]);
    const coding = new CodingService(conv, CONFIG, net.fetch);

    await expect(
      coding.start({ bot: "main", prompt: "go", repo: "git@github.com:mblode/expert.git" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(net.calls).toHaveLength(0);
  });

  it("refuses to refresh a conversation that is not a coding session", async () => {
    const conv = registry();
    const seat = conv.resolveSeat("main");
    const coding = new CodingService(conv, CONFIG, runner([{}]).fetch);

    await expect(coding.refresh(seat.id)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("is a 4xx for the caller and a DAEMON_DOWN for the runner", async () => {
    const conv = registry();
    const refused: FetchLike = async () => new Response("no such repo", { status: 404 });
    await expect(
      new CodingService(conv, CONFIG, refused).start({
        bot: "main",
        prompt: "go",
        repo: REPO,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    const broken: FetchLike = async () => new Response("boom", { status: 502 });
    await expect(
      new CodingService(conv, CONFIG, broken).start({ bot: "main", prompt: "go", repo: REPO }),
    ).rejects.toMatchObject({ code: "DAEMON_DOWN" });
  });

  it("never puts the key in an error a caller can read", async () => {
    const conv = registry();
    const refused: FetchLike = async () => new Response("nope", { status: 401 });
    const service = new CodingService(conv, { ...CONFIG, apiKey: "sk-secret" }, refused);
    const refusal: unknown = await service
      .start({ bot: "main", prompt: "go", repo: REPO })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ComputerError);
    expect(JSON.stringify(refusal)).not.toContain("sk-secret");
    expect((refusal as ComputerError).message).not.toContain("sk-secret");
  });

  it("answers DAEMON_DOWN when no runner is configured, like WhatsApp without a bridge", async () => {
    const coding = new CodingService(registry(), undefined, runner([{}]).fetch);
    expect(coding.enabled).toBe(false);
    await expect(coding.start({ bot: "main", prompt: "go", repo: REPO })).rejects.toMatchObject({
      code: "DAEMON_DOWN",
    });
  });

  it("is off without a key and takes the endpoint from the environment", () => {
    expect(codingConfigFromEnv({} as NodeJS.ProcessEnv)).toBeUndefined();
    expect(codingConfigFromEnv({ CURSOR_API_KEY: "  " } as NodeJS.ProcessEnv)).toBeUndefined();
    expect(
      codingConfigFromEnv({
        CURSOR_API_KEY: "k",
        CURSOR_API_URL: "https://runner.test/",
      } as NodeJS.ProcessEnv),
    ).toMatchObject({ apiKey: "k", endpoint: "https://runner.test" });
  });

  it("lists only the sessions of Bots the caller may see", async () => {
    const conv = registry();
    const net = runner([
      { agent: agent({ id: "bc-1" }), run: run("RUNNING") },
      { agent: agent({ id: "bc-2" }), run: { ...run("RUNNING"), agentId: "bc-2" } },
    ]);
    const coding = new CodingService(conv, CONFIG, net.fetch);
    await coding.start({ bot: "main", prompt: "one", repo: REPO });
    await coding.start({ bot: "night", prompt: "two", repo: REPO });
    // The seat thread is not a coding session and never appears here.
    conv.resolveSeat("main");

    expect(coding.list(new Set(["main"]))).toEqual([
      { agent: "bc-1", conversation_id: expect.any(String), repo: REPO },
    ]);
    expect(coding.list(new Set(["main", "night"]))).toHaveLength(2);
  });

  describe("over the wire", () => {
    const opened: { close: () => Promise<void> }[] = [];
    afterEach(async () => {
      while (opened.length) {
        await opened.pop()?.close();
      }
    });

    it("starts, lists and reads one back through the Seat RPCs", async () => {
      const net = runner([
        { agent: agent(), run: run("RUNNING") },
        agent(),
        run("FINISHED", { result: "done" }),
      ]);
      // The hub's own conversation store, so the thread the session writes
      // is the thread `Seat.Occurrences` reads.
      const h = await startHub({
        codingFactory: (conversations) => new CodingService(conversations, CONFIG, net.fetch),
      });
      opened.push(h);
      const token = await h.pair();

      const started = (await rpc(
        h.url,
        "/computer.v1.Seat/StartCodingSession",
        { prompt: "fix the flake", repo: REPO },
        token,
      )) as { conversation_id: string; state: string; agent: string };
      expect(started.state).toBe("active");
      expect(started.agent).toBe("bc-1");

      const listed = (await rpc(h.url, "/computer.v1.Seat/CodingSessions", {}, token)) as {
        sessions: { conversation_id: string; repo: string }[];
      };
      expect(listed.sessions).toEqual([
        { agent: "bc-1", conversation_id: started.conversation_id, repo: REPO },
      ]);

      const refreshed = (await rpc(
        h.url,
        "/computer.v1.Seat/RefreshCodingSession",
        { conversation_id: started.conversation_id },
        token,
      )) as { state: string; summary: string };
      expect(refreshed.state).toBe("complete");
      expect(refreshed.summary).toBe("done");

      // The thread is the record, read by the same RPC everything else uses.
      const page = (await rpc(
        h.url,
        "/computer.v1.Seat/Occurrences",
        { conversation_id: started.conversation_id },
        token,
      )) as { entries: { kind: string; text: string }[] };
      expect(page.entries.map((e) => e.kind)).toEqual(["human", "text", "text"]);
      expect(page.entries[0]?.text).toBe("fix the flake");
    });

    it("is DAEMON_DOWN on a hub with no runner configured", async () => {
      const h = await startHub({
        codingFactory: (conversations) => new CodingService(conversations, undefined),
      });
      opened.push(h);
      const token = await h.pair();
      await expect(
        rpc(h.url, "/computer.v1.Seat/StartCodingSession", { prompt: "go", repo: REPO }, token),
      ).rejects.toMatchObject({ code: "DAEMON_DOWN" });
    });
  });
});
