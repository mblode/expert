import { describe, expect, it } from "vitest";
import { mintInvite, publicInviteUrl, resolveMinter, unavailableNote } from "./expert_invite.ts";
import type { InviteDeps } from "./expert_invite.ts";

const ENV = { EXPERT_INVITE_SECRET: "mint-me", EXPERT_ORIGIN: "https://hello.expert" };

/** A fetch that records the one request it gets and answers with `status`/`body`. */
const stubFetch = (status: number, body: unknown, env: NodeJS.ProcessEnv = ENV) => {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fn = (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      init: init ?? {},
      url: String(url),
    });
    return Promise.resolve(Response.json(body, { status }));
  };
  return { calls, deps: { env, fetch: fn } as InviteDeps };
};

describe("resolveMinter", () => {
  it("needs a secret, because an origin without one is a route that answers 401", () => {
    expect(resolveMinter({})).toBeNull();
    expect(resolveMinter({ EXPERT_INVITE_SECRET: "   " })).toBeNull();
    expect(resolveMinter({ EXPERT_INVITE_SECRET: "s" })).toEqual({
      origin: "https://hello.expert",
      secret: "s",
    });
  });

  it("takes the origin from the environment, without its trailing slash", () => {
    expect(
      resolveMinter({ EXPERT_INVITE_SECRET: "s", EXPERT_ORIGIN: "http://localhost:3000/" })?.origin,
    ).toBe("http://localhost:3000");
  });
});

describe("publicInviteUrl", () => {
  it("passes a link on the origin it asked", () => {
    expect(publicInviteUrl("https://hello.expert/desk/abc123", "https://hello.expert")).toBe(
      "https://hello.expert/desk/abc123",
    );
  });

  it("refuses another host, plain http, and credentials in the URL", () => {
    expect(publicInviteUrl("https://evil.example/desk/abc", "https://hello.expert")).toBeNull();
    expect(publicInviteUrl("http://hello.expert/desk/abc", "https://hello.expert")).toBeNull();
    expect(
      publicInviteUrl("https://user:pw@hello.expert/desk/abc", "https://hello.expert"),
    ).toBeNull();
    expect(publicInviteUrl("not a url", "https://hello.expert")).toBeNull();
    expect(publicInviteUrl(undefined, "https://hello.expert")).toBeNull();
  });

  it("drops the query and the fragment: the token is the path", () => {
    expect(
      publicInviteUrl("https://hello.expert/desk/abc?seat=leaked#x", "https://hello.expert"),
    ).toBe("https://hello.expert/desk/abc");
  });

  it("allows loopback over http, so a local control plane still mints", () => {
    expect(publicInviteUrl("http://localhost:3000/desk/abc", "http://localhost:3000")).toBe(
      "http://localhost:3000/desk/abc",
    );
  });
});

describe("mintInvite", () => {
  it("says the sign-in line when this Bot holds no mint secret", async () => {
    expect(await mintInvite("desk", "g@g.us", { env: {} })).toEqual({
      available: false,
      kind: "desk",
      note: unavailableNote(),
    });
  });

  it("posts the kind, the chat and a short ttl, with the secret in a header", async () => {
    const { calls, deps } = stubFetch(200, { url: "https://hello.expert/desk/tok" });
    const result = await mintInvite("desk", "g@g.us", deps);

    expect(result).toEqual({
      available: true,
      expires_in_minutes: 30,
      kind: "desk",
      url: "https://hello.expert/desk/tok",
    });
    expect(calls[0]?.url).toBe("https://hello.expert/api/invite");
    expect(calls[0]?.body).toEqual({ kind: "desk", sender: "g@g.us", ttlMinutes: 30 });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["x-invite-secret"]).toBe("mint-me");
    // The secret is a header and only a header: nothing carries it into the
    // body, where a log or an error echo would repeat it.
    expect(JSON.stringify(calls[0]?.body)).not.toContain("mint-me");
  });

  it("degrades to the sign-in line on a refusal, a dead control plane, or a foreign url", async () => {
    const refused = stubFetch(403, { error: "This mint secret cannot open that computer." });
    expect(await mintInvite("desk", undefined, refused.deps)).toEqual({
      available: false,
      kind: "desk",
      note: unavailableNote(),
    });

    const dead: InviteDeps = { env: ENV, fetch: () => Promise.reject(new Error("ECONNREFUSED")) };
    const unreachable = await mintInvite("plugin", undefined, dead);
    expect(unreachable.available).toBe(false);

    const elsewhere = stubFetch(200, { url: "https://evil.example/desk/tok" });
    const foreign = await mintInvite("desk", undefined, elsewhere.deps);
    expect(foreign.available).toBe(false);
  });

  it("names the configured host in the fallback, so the line is not a wrong address", () => {
    expect(unavailableNote("https://vibey.example.com")).toContain("vibey.example.com");
    expect(unavailableNote("nonsense")).toContain("hello.expert");
  });
});
