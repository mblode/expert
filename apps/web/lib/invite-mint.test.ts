import { describe, expect, it } from "vitest";

import { canMintInvite, INVITE_SECRET_HEADER } from "./invite-access";
import { mintInviteWithoutStore, respondToInviteMint } from "./invite-mint";
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
