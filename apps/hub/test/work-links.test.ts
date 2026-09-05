import { CodingService } from "../src/service/coding.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workLink } from "../src/service/work-links.ts";
import { rpc, startHub } from "./helper.ts";

afterEach(() => vi.unstubAllEnvs());
describe("owner breakout", () => {
  it("contains navigation context but no credential", () => {
    const url = new URL(
      workLink("computer", "main", "conv_one", {
        COMPUTER_PUBLIC_URL: "https://one.fly.dev",
        COMPUTER_WEB_URL: "https://hello.expert/",
      }),
    );
    expect(url.pathname).toBe("/work");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      view: "computer",
      bot: "main",
      hub: "https://one.fly.dev",
      conversation: "conv_one",
    });
  });
  it("refuses unconfigured and insecure destinations", () => {
    expect(() => workLink("code", "main", undefined, {})).toThrow("not configured");
    expect(() =>
      workLink("code", "main", undefined, {
        COMPUTER_PUBLIC_URL: "https://one.fly.dev",
        COMPUTER_WEB_URL: "http://evil.example",
      }),
    ).toThrow("not configured");
  });
  it("derives bot and conversation from auth rather than model arguments", async () => {
    vi.stubEnv("COMPUTER_PUBLIC_URL", "https://one.fly.dev");
    const h = await startHub();
    try {
      const result = await rpc(
        h.url,
        "/computer.v1.Agent/SendMessage",
        { kind: "link", destination: "code", bot: "someone-else", conversation_id: "conv_else" },
        h.agent,
      );
      const url = new URL((result as { url: string }).url);
      expect(url.searchParams.get("bot")).toBe("main");
      expect(url.searchParams.has("conversation")).toBe(false);
      expect(h.hub.conversations.list()).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

it("coding dispatch requires a bound owner and an enabled repository", async () => {
  vi.stubEnv("COMPUTER_PUBLIC_URL", "https://one.fly.dev");
  const owner = { acct: "one", jid: "123@s.whatsapp.net" };
  const repo = "https://github.com/mblode/expert";
  let creates = 0;
  const h = await startHub({
    paOwner: owner,
    paRepos: [repo],
    codingFactory: (conversations) =>
      new CodingService(conversations, "test-key", async (_url, init) => {
        creates += 1;
        const { agentId } = JSON.parse(String(init.body));
        return Response.json({ id: agentId, url: "https://cursor.com/agents/test" });
      }),
  });
  try {
    const conversation = h.hub.conversations.resolve(
      "main",
      { kind: "whatsapp", acct: owner.acct, jid: owner.jid },
      [],
    );
    const anonymous = h.hub.turns.mint({ bot: "main", conversation_id: conversation.id });
    const trusted = h.hub.turns.mint({ bot: "main", conversation_id: conversation.id, owner });
    const send = (turn: string, selected = repo) =>
      fetch(`${h.url}/computer.v1.Agent/SendMessage`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${h.agent}`,
          "content-type": "application/json",
          "x-computer-turn": turn,
        },
        body: JSON.stringify({ kind: "code", repo: selected, text: "Fix the test" }),
      });
    const denied = await send(anonymous.id);
    expect(denied.status).toBe(403);
    const outside = await send(trusted.id, "https://github.com/other/project");
    expect(outside.status).toBe(403);
    expect(creates).toBe(0);
    const started = await send(trusted.id);
    expect(started.status).toBe(200);
    const repeated = await send(trusted.id);
    expect(repeated.status).toBe(200);
    expect(creates).toBe(1);
  } finally {
    await h.close();
  }
});
