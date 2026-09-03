import { describe, expect, it, vi } from "vitest";

import { computerById, VIBEY_HUB_URL } from "./computers";
import type { ComputerRecord } from "./computers";
import { bootstrapIssuer, hasIssuer, issueSeatAsIssuer } from "./issuer";
import type { IssuerStore } from "./issuer";

const vibeyCode = "vibey-setup";

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { COMPUTER_SETUP_CODE: "blode-setup", COMPUTER_SETUP_CODE_VCMC: vibeyCode, ...extra };
}

function vibey(): ComputerRecord {
  const computer = computerById("vibey", env());
  if (!computer) {
    throw new Error("vibey is not in the catalog");
  }
  return computer;
}

/** The `computer` row, without Turso. */
function memoryStore(seed?: string): IssuerStore & { token: string | undefined } {
  const state = { token: seed };
  return {
    clear: async () => {
      state.token = undefined;
    },
    read: async () => state.token,
    get token() {
      return state.token;
    },
    write: async (_id, token) => {
      state.token = token;
    },
  };
}

function hub(handler: (method: string, body: Record<string, unknown>) => Response): {
  calls: { body: Record<string, unknown>; method: string; token?: string }[];
  fetchImpl: typeof fetch;
} {
  const calls: { body: Record<string, unknown>; method: string; token?: string }[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const method = String(input).split("/computer.v1.Seat/")[1] ?? "";
    const auth = new Headers(init?.headers).get("authorization") ?? undefined;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ body, method, ...(auth ? { token: auth.replace("Bearer ", "") } : {}) });
    return handler(method, body);
  });
  return { calls, fetchImpl };
}

function bootstrapHub() {
  return hub((method, body) => {
    if (method === "Pair") {
      return body.code === vibeyCode
        ? Response.json({ token: "owner_once" })
        : Response.json(
            { error: { code: "UNAUTHENTICATED", message: "bad setup code" } },
            {
              status: 401,
            },
          );
    }
    if (method === "Issue") {
      return Response.json({ expires_at: "", role: body.role, token: "issuer_minted" });
    }
    return Response.json({ revoked: true });
  });
}

describe("bootstrapIssuer", () => {
  it("spends the setup code once, stores the issuer, and gives the owner back", async () => {
    const { calls, fetchImpl } = bootstrapHub();
    const store = memoryStore();
    await expect(bootstrapIssuer(vibey(), env(), { fetchImpl, store })).resolves.toEqual({
      ok: true,
    });

    expect(calls.map((call) => call.method)).toEqual(["Pair", "Issue", "Revoke"]);
    expect(calls[0]?.body).toEqual({ code: vibeyCode });
    // No ttl: this is the deployment's identity on the box, not a session, so
    // invites do not stop working at an hour nobody chose.
    expect(calls[1]).toMatchObject({
      body: {
        label: "hello.expert control plane",
        role: "issuer",
        subject: "control-plane:vibey",
      },
      token: "owner_once",
    });
    expect(calls[1]?.body).not.toHaveProperty("ttl_sec");
    // The paired owner does not survive the call that minted the issuer.
    expect(calls[2]).toMatchObject({ body: {}, method: "Revoke", token: "owner_once" });
    expect(store.token).toBe("issuer_minted");
    expect(await hasIssuer(vibey(), store)).toBe(true);
  });

  it("refuses without that computer's setup code, and touches no hub", async () => {
    const { calls, fetchImpl } = bootstrapHub();
    const store = memoryStore();
    const result = await bootstrapIssuer(
      vibey(),
      { COMPUTER_SETUP_CODE: "blode-setup" },
      {
        fetchImpl,
        store,
      },
    );
    expect(result).toMatchObject({ error: expect.stringContaining("COMPUTER_SETUP_CODE_VCMC") });
    expect(calls).toEqual([]);
    expect(store.token).toBeUndefined();
  });

  it("hands a grant it cannot store back to the hub rather than leaking it", async () => {
    const { calls, fetchImpl } = bootstrapHub();
    const store: IssuerStore = {
      clear: async () => undefined,
      read: async () => undefined,
      write: async () => {
        throw new Error("turso is down");
      },
    };
    const result = await bootstrapIssuer(vibey(), env(), { fetchImpl, store });
    expect(result).toMatchObject({
      error: "Could not store the issuer credential. Nothing was changed.",
    });
    // The unstorable issuer is revoked, and so is the owner that minted it.
    const revoked = calls.filter((call) => call.method === "Revoke").map((call) => call.token);
    expect(revoked).toEqual(["issuer_minted", "owner_once"]);
    expect(await hasIssuer(vibey(), store)).toBe(false);
  });
});

describe("issueSeatAsIssuer", () => {
  it("issues with the stored grant and never pairs", async () => {
    const { calls, fetchImpl } = hub((_method, body) =>
      Response.json({ expires_at: "", role: body.role, token: "seat_guest" }),
    );
    const store = memoryStore("issuer_stored");
    const issued = await issueSeatAsIssuer(
      vibey(),
      { display: 1, role: "guest", ttlMs: 60_000 },
      { fetchImpl, store },
    );
    expect(issued).toEqual({ expiresAt: "", role: "guest", token: "seat_guest" });
    expect(calls).toEqual([
      {
        body: { display: 1, role: "guest", ttl_sec: 60 },
        method: "Issue",
        token: "issuer_stored",
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain(vibeyCode);
  });

  it("refuses when there is no issuer, and does not fall back to Pair", async () => {
    const { calls, fetchImpl } = bootstrapHub();
    const result = await issueSeatAsIssuer(
      vibey(),
      { role: "guest", ttlMs: 60_000 },
      { fetchImpl, store: memoryStore() },
    );
    // A setup code is still in env here. Fail closed means it stays unspent.
    expect(result).toMatchObject({
      error: expect.stringContaining("has no issuer on the Vibey computer yet"),
    });
    expect(calls).toEqual([]);
  });

  it("forgets an issuer the hub rejects, and still refuses rather than pairing", async () => {
    const { calls, fetchImpl } = hub((method) =>
      method === "Issue"
        ? Response.json(
            { error: { code: "UNAUTHENTICATED", message: "seat token required" } },
            { status: 401 },
          )
        : Response.json({ token: "owner_once" }),
    );
    const store = memoryStore("issuer_revoked_at_the_box");
    const result = await issueSeatAsIssuer(
      vibey(),
      { role: "guest", ttlMs: 60_000 },
      { fetchImpl, store },
    );
    expect(result).toMatchObject({ error: expect.stringContaining("refused this control plane") });
    expect(calls.map((call) => call.method)).toEqual(["Issue"]);
    expect(store.token).toBeUndefined();
  });

  it("keeps the issuer when the box is merely unreachable", async () => {
    const store = memoryStore("issuer_stored");
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await issueSeatAsIssuer(
      vibey(),
      { role: "guest", ttlMs: 60_000 },
      { fetchImpl, store },
    );
    expect(result).toMatchObject({ error: expect.stringContaining(VIBEY_HUB_URL) });
    // An unreachable Fly machine is not a revoked credential. Dropping it here
    // would turn a restart into a bootstrap nobody asked for.
    expect(store.token).toBe("issuer_stored");
  });
});
