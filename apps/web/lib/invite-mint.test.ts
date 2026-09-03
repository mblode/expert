import { describe, expect, it } from "vitest";

import { canMintInvite, INVITE_SECRET_HEADER } from "./invite-access";
import { mintInviteWithoutStore, respondToInviteMint } from "./invite-mint";
import type { InviteMintFn } from "./invite-mint";
import { invitePath } from "./invite-origin";

const secret = "eve-invite-secret";
const now = 1_700_000_000_000;

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    BETTER_AUTH_URL: "https://hello.expert",
    COMPUTER_SETUP_CODE: "blode-setup",
    COMPUTER_SETUP_CODE_VCMC: "vibey-setup",
    EXPERT_INVITE_SECRET: secret,
    ...extra,
  };
}

function mintRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://hello.expert/api/invite", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

/** Same accept rules as vcmc-agent `publicInviteUrl`. */
function evePublicInviteUrl(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") {
    return null;
  }
  if (!["hello.expert", "www.hello.expert"].includes(url.hostname.toLowerCase())) {
    return null;
  }
  for (const key of url.searchParams.keys()) {
    if (["seat", "secret", "token"].includes(key.toLowerCase())) {
      return null;
    }
  }
  return url.toString();
}

async function eveMint(kind: string, headers: Record<string, string> = {}): Promise<Response> {
  return respondToInviteMint(mintRequest({ kind }, headers), undefined, {
    env: env(),
    mint: mintInviteWithoutStore,
    now,
  });
}

describe("canMintInvite", () => {
  it("accepts x-invite-secret, Bearer, and an operator session", () => {
    const allowed = env();
    expect(
      canMintInvite(
        mintRequest({ kind: "desk" }, { [INVITE_SECRET_HEADER]: secret }),
        undefined,
        allowed,
      ),
    ).toBe(true);
    expect(
      canMintInvite(
        mintRequest({ kind: "desk" }, { authorization: `Bearer ${secret}` }),
        undefined,
        allowed,
      ),
    ).toBe(true);
    expect(
      canMintInvite(
        mintRequest({ kind: "desk" }, { [INVITE_SECRET_HEADER]: secret }),
        undefined,
        env({ EXPERT_INVITE_SECRET: undefined, INVITE_MINT_SECRET: secret }),
      ),
    ).toBe(true);
    expect(
      canMintInvite(mintRequest({ kind: "desk" }), "m@blode.co", {
        COMPUTER_OPERATOR_EMAILS: "m@blode.co",
      }),
    ).toBe(true);
    expect(canMintInvite(mintRequest({ kind: "desk" }), undefined, allowed)).toBe(false);
    expect(
      canMintInvite(
        mintRequest({ kind: "desk" }, { [INVITE_SECRET_HEADER]: "nope" }),
        undefined,
        allowed,
      ),
    ).toBe(false);
  });
});

describe("Eve mint client", () => {
  it("POSTs { kind: desk } with x-invite-secret and returns a hello.expert /desk url", async () => {
    const res = await eveMint("desk", { [INVITE_SECRET_HEADER]: secret });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        computerId: "vibey",
        purpose: "desk",
      }),
    );
    const url =
      body && typeof body === "object" && "url" in body ? evePublicInviteUrl(body.url) : null;
    expect(url).toBeTruthy();
    const parsed = new URL(url as string);
    expect(parsed.origin).toBe("https://hello.expert");
    expect(parsed.pathname.startsWith("/desk/")).toBe(true);
    expect(parsed.pathname).toMatch(/^\/desk\/[A-Za-z0-9_-]+$/u);
    expect(parsed.search).toBe("");
    expect(invitePath("desk", parsed.pathname.slice("/desk/".length))).toBe(parsed.pathname);
  });

  it("POSTs { kind: plugin } and returns /plugins, not a query token", async () => {
    const res = await eveMint("plugin", { [INVITE_SECRET_HEADER]: secret });
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    const url =
      body && typeof body === "object" && "url" in body ? evePublicInviteUrl(body.url) : null;
    expect(url).toBeTruthy();
    const parsed = new URL(url as string);
    expect(parsed.pathname.startsWith("/plugins/")).toBe(true);
    expect(parsed.search).toBe("");
    expect(body).toEqual(expect.objectContaining({ purpose: "plugins" }));
  });

  it("returns 401 without a mint secret and 400 for an unknown kind", async () => {
    const missing = await eveMint("desk");
    expect(missing.status).toBe(401);
    const unknown = await eveMint("widgets", { [INVITE_SECRET_HEADER]: secret });
    expect(unknown.status).toBe(400);
  });
});

describe("what a mint secret may open", () => {
  const mint = async (
    body: Record<string, unknown>,
    headers: Record<string, string>,
    email?: string,
    extraEnv: Record<string, string | undefined> = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await respondToInviteMint(mintRequest(body, headers), email, {
      env: env(extraEnv),
      mint: mintInviteWithoutStore,
      now,
    });
    return { body: (await res.json()) as Record<string, unknown>, status: res.status };
  };

  it("refuses a secret-minted link for another tenant's computer", async () => {
    // The secret lives on Vibey's Eve. Before this it could name any id in the
    // catalog, and redeeming that link is a seat on someone else's machine.
    const res = await mint(
      { computerId: "blode", kind: "desk" },
      { [INVITE_SECRET_HEADER]: secret },
    );
    expect(res.status).toBe(403);
    expect(res.body.computerId).toBeUndefined();
  });

  it("still mints for the computer the secret is pinned to, under either spelling", async () => {
    for (const computerId of [undefined, "vibey", "vcmc"]) {
      const res = await mint(
        { kind: "desk", ...(computerId ? { computerId } : {}) },
        { [INVITE_SECRET_HEADER]: secret },
      );
      expect(res.status).toBe(200);
      expect(res.body.computerId).toBe("vibey");
    }
  });

  it("follows INVITE_MINT_COMPUTER_ID when the deployment moves the secret", async () => {
    const res = await mint({ kind: "desk" }, { [INVITE_SECRET_HEADER]: secret }, undefined, {
      INVITE_MINT_COMPUTER_ID: "blode",
    });
    expect(res.status).toBe(200);
    expect(res.body.computerId).toBe("blode");
  });

  it("caps a Bot and not an operator, and reports the cap as 429", async () => {
    const seen: boolean[] = [];
    const capped: InviteMintFn = (input, request, mintEnv, at, limited) => {
      seen.push(limited);
      return limited
        ? Promise.resolve({ error: "Too many links.", status: 429 as const })
        : mintInviteWithoutStore(input, request, mintEnv, at);
    };
    const call = (headers: Record<string, string>, email?: string): Promise<Response> =>
      respondToInviteMint(mintRequest({ kind: "desk" }, headers), email, {
        env: env({ COMPUTER_OPERATOR_EMAILS: "m@blode.co" }),
        mint: capped,
        now,
      });

    const bot = await call({ [INVITE_SECRET_HEADER]: secret });
    expect(bot.status).toBe(429);
    const operator = await call({}, "m@blode.co");
    expect(operator.status).toBe(200);
    expect(seen).toEqual([true, false]);
  });

  it("leaves an operator free to mint on any computer they can open", async () => {
    const res = await mint({ computerId: "blode", kind: "desk" }, {}, "m@blode.co", {
      COMPUTER_OPERATOR_EMAILS: "m@blode.co",
    });
    expect(res.status).toBe(200);
    expect(res.body.computerId).toBe("blode");
  });
});
