// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { NotConnectedError } from "./account.ts";
import type { AccountHandle, AccountHealth, LinkState } from "./account.ts";
import { defaultAccountConfig } from "./accounts.ts";
import type { AccountConfig, AccountSummary } from "./accounts.ts";
import { HttpError, startServer } from "./server.ts";
import type { BridgeApi, StartServerArgs } from "./server.ts";
import type { Store } from "./store.ts";

const SECRET = "test-secret";
const QR = "2@abc123/pairing+string==";
const DM = "61400000000@s.whatsapp.net";

const noopLogger = {
  debug: () => {
    // silenced in tests
  },
  error: () => {
    // silenced in tests
  },
  info: () => {
    // silenced in tests
  },
  warn: () => {
    // silenced in tests
  },
} as unknown as StartServerArgs["logger"];

/** A fake account: records what the routes hand it, answers canned data. */
interface FakeAccount {
  summary: AccountSummary;
  health: AccountHealth;
  link: LinkState;
  config: AccountConfig;
  handle: AccountHandle;
  sends: { jid: string; text: string; key?: string }[];
}

const fakeAccount = (acct: string, overrides: Partial<FakeAccount> = {}): FakeAccount => {
  const sends: FakeAccount["sends"] = [];
  const store = {
    allMessages: async () => [{ s: "A", t: 1, x: `all:${acct}` }],
    recentMessages: async (_jid: string, n: number) => [{ s: "A", t: 1, x: `${acct}:${n}` }],
    recentReactions: async () => [],
    recentResources: async () => [],
  } as unknown as Store;
  return {
    config: defaultAccountConfig(),
    handle: {
      acct,
      getMembers: () => ({ members: [], ready: true }),
      onBackfill: async () => ({ anchor: "m1", requested: 10 }),
      onInvite: async () => ({ delivered: true }),
      onReport: async () => ({ delivered: true }),
      onSend: async (jid, text, key) => {
        sends.push({ jid, key, text });
        return { sent: true };
      },
      onSendMedia: async () => ({ sent: true }),
      store,
    },
    health: { acct, attempts: 0, failingSince: null, lastCloseCode: null, whatsapp: "connecting" },
    link: { acct, age_ms: 1200, pairing_code: null, phone: null, qr: QR, status: "linking" },
    sends,
    summary: { acct, bot: acct, channel_id: `whatsapp-${acct}`, phone: null, status: "linking" },
    ...overrides,
  };
};

const accounts = new Map<string, FakeAccount>();
const created: Record<string, unknown>[] = [];
let baseUrl = "";
let server: ReturnType<typeof startServer>;

const api: BridgeApi = {
  accountIds: () => [...accounts.keys()],
  createAccount: async (body) => {
    if (typeof body.acct !== "string" || !body.channel_secret) {
      throw new HttpError(400, "acct and channel_secret required");
    }
    if (accounts.has(body.acct)) {
      throw new HttpError(409, "exists");
    }
    created.push(body);
    const fake = fakeAccount(body.acct);
    accounts.set(body.acct, fake);
    return fake.summary;
  },
  deleteAccount: async (acct) => accounts.delete(acct),
  getConfig: (acct) => accounts.get(acct)?.config,
  handle: (acct) => accounts.get(acct)?.handle,
  health: () => [...accounts.values()].map((a) => a.health),
  joinGroup: async (acct, invite) => {
    if (!accounts.has(acct)) {
      throw new HttpError(404, "unknown");
    }
    if (invite === "closed") {
      throw new NotConnectedError();
    }
    return `${invite}@g.us`;
  },
  link: async (acct, phone) => {
    const fake = accounts.get(acct);
    if (!fake) {
      throw new HttpError(404, "unknown");
    }
    fake.link = phone
      ? { acct, age_ms: 10, pairing_code: "ABCD-EFGH", phone, qr: null, status: "linking" }
      : { acct, age_ms: 10, pairing_code: null, phone: null, qr: QR, status: "linking" };
    return fake.link;
  },
  linkState: (acct) => accounts.get(acct)?.link,
  listAccounts: () => [...accounts.values()].map((a) => a.summary),
  listGroups: async (acct) => {
    if (!accounts.has(acct)) {
      throw new HttpError(404, "unknown");
    }
    return [{ enabled: true, jid: "1@g.us", size: 3, subject: "Test" }];
  },
  setConfig: async (acct, raw) => {
    const fake = accounts.get(acct);
    if (!fake) {
      throw new HttpError(404, "unknown");
    }
    if (typeof raw !== "object" || raw === null) {
      throw new HttpError(400, "config must be an object");
    }
    fake.config = { ...fake.config, ...(raw as Partial<AccountConfig>) };
    return fake.config;
  },
};

before(async () => {
  accounts.set("main", fakeAccount("main"));
  server = startServer({ api, host: "127.0.0.1", logger: noopLogger, port: 0, secret: SECRET });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(() => {
  server.close();
});

const get = (path: string, auth = true) =>
  fetch(`${baseUrl}${path}`, { headers: auth ? { "x-bridge-secret": SECRET } : {} });

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${baseUrl}${path}`, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "content-type": "application/json", "x-bridge-secret": SECRET },
    method,
  });

const status = async (pending: Promise<Response>): Promise<number> => {
  const res = await pending;
  return res.status;
};

const text = async (pending: Promise<Response>): Promise<string> => {
  const res = await pending;
  return res.text();
};

const json = async (pending: Promise<Response>): Promise<unknown> => {
  const res = await pending;
  return res.json();
};

// ---- auth and health ------------------------------------------------------

test("GET /health needs no secret and lists every account's socket state", async () => {
  const res = await get("/health", false);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    accounts: [
      {
        acct: "main",
        attempts: 0,
        failingSince: null,
        lastCloseCode: null,
        whatsapp: "connecting",
      },
    ],
    ok: true,
  });
});

// A stuck socket drops every message silently, and the in-band alert path (a
// DM to the maintainer) needs the very socket that is down, so /health has to
// carry enough to spot it from outside.
test("GET /health surfaces a stuck connection", async () => {
  accounts.get("main")!.health = {
    acct: "main",
    attempts: 7,
    failingSince: "2026-07-28T22:46:00.000Z",
    lastCloseCode: 405,
    whatsapp: "close",
  };
  const body = (await json(get("/health", false))) as { accounts: AccountHealth[] };
  assert.equal(body.accounts[0]?.lastCloseCode, 405);
  assert.equal(body.accounts[0]?.attempts, 7);
});

test("every other route rejects a missing or wrong secret", async () => {
  assert.equal(await status(get("/accounts", false)), 401);
  assert.equal(await status(get("/accounts/main/link", false)), 401);
  const wrong = await fetch(`${baseUrl}/accounts`, { headers: { "x-bridge-secret": "nope" } });
  assert.equal(wrong.status, 401);
});

// ---- accounts ---------------------------------------------------------------

test("GET /accounts lists summaries and never the channel secret", async () => {
  const res = await get("/accounts");
  assert.equal(res.status, 200);
  const raw = await res.text();
  assert.equal(raw.includes("secret"), false);
  assert.deepEqual(JSON.parse(raw), {
    accounts: [
      { acct: "main", bot: "main", channel_id: "whatsapp-main", phone: null, status: "linking" },
    ],
  });
});

test("POST /accounts creates (201), refuses a duplicate (409) and a bad body (400)", async () => {
  const res = await call("POST", "/accounts", {
    acct: "second",
    bot: "main",
    channel_id: "whatsapp-second",
    channel_secret: "s2",
  });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { acct: "second" });
  assert.equal(created.at(-1)?.channel_id, "whatsapp-second");
  assert.equal(
    await status(call("POST", "/accounts", { acct: "second", channel_secret: "s2" })),
    409,
  );
  assert.equal(await status(call("POST", "/accounts", { bot: "main" })), 400);
  assert.equal(await status(call("POST", "/accounts", "[]")), 400);
});

test("DELETE /accounts/:acct removes it, 404 when unknown", async () => {
  assert.equal(await status(call("DELETE", "/accounts/second")), 200);
  assert.equal(await status(call("DELETE", "/accounts/second")), 404);
  assert.equal(accounts.has("second"), false);
});

// ---- link ---------------------------------------------------------------------

test("GET /accounts/:acct/link returns the pairing QR when the secret matches", async () => {
  const res = await get("/accounts/main/link");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    acct: "main",
    age_ms: 1200,
    pairing_code: null,
    phone: null,
    qr: QR,
    status: "linking",
  });
  assert.equal(await status(get("/accounts/nope/link")), 404);
});

// A pairing QR is a credential: scanning it links a device to the account, so
// an unauthenticated caller must never be able to read one. /health is the
// route most likely to leak it by accident.
test("GET /health never exposes the QR", async () => {
  const body = await text(get("/health", false));
  assert.equal(body.includes(QR), false);
});

test("POST /accounts/:acct/link with a phone yields a pairing code, without one a QR", async () => {
  const byCode = await call("POST", "/accounts/main/link", { phone: "61400000000" });
  assert.equal(byCode.status, 200);
  const codeState = (await byCode.json()) as LinkState;
  assert.equal(codeState.pairing_code, "ABCD-EFGH");
  assert.equal(codeState.qr, null);
  const byQr = await call("POST", "/accounts/main/link", {});
  const qrState = (await byQr.json()) as LinkState;
  assert.equal(qrState.qr, QR);
  assert.equal(qrState.pairing_code, null);
  assert.equal(await status(call("POST", "/accounts/main/link", { phone: 123 })), 400);
});

test("a linked socket serves neither a QR nor a code", async () => {
  accounts.get("main")!.link = {
    acct: "main",
    age_ms: null,
    pairing_code: null,
    phone: "61400000000",
    qr: null,
    status: "open",
  };
  const state = (await json(get("/accounts/main/link"))) as LinkState;
  assert.equal(state.status, "open");
  assert.equal(state.qr, null);
  assert.equal(state.pairing_code, null);
});

// ---- groups and config --------------------------------------------------------

test("GET /accounts/:acct/groups lists groups with their enabled flag", async () => {
  const res = await get("/accounts/main/groups");
  assert.deepEqual(await res.json(), {
    groups: [{ enabled: true, jid: "1@g.us", size: 3, subject: "Test" }],
  });
});

test("POST /accounts/:acct/groups/join returns the jid, 400 without an invite, 503 when offline", async () => {
  const res = await call("POST", "/accounts/main/groups/join", { invite: "AbC123" });
  assert.deepEqual(await res.json(), { jid: "AbC123@g.us" });
  assert.equal(await status(call("POST", "/accounts/main/groups/join", {})), 400);
  assert.equal(await status(call("POST", "/accounts/main/groups/join", { invite: "closed" })), 503);
});

test("GET /accounts/:acct/config returns every field populated on a fresh account", async () => {
  const res = await get("/accounts/main/config");
  const { config } = (await res.json()) as { config: AccountConfig };
  assert.deepEqual(config, defaultAccountConfig());
  assert.equal(config.group_policy, "all");
  assert.equal(config.maintainer_jid, "");
});

test("PUT /accounts/:acct/config persists and echoes the config, 400 on a bad body", async () => {
  const res = await call("PUT", "/accounts/main/config", { config: { trigger_mode: "all" } });
  assert.equal(res.status, 200);
  const { config } = (await res.json()) as { config: AccountConfig };
  assert.equal(config.trigger_mode, "all");
  assert.equal(await status(call("PUT", "/accounts/main/config", { config: "all" })), 400);
  assert.equal(await status(call("PUT", "/accounts/nope/config", { config: {} })), 404);
});

// ---- legacy data routes -------------------------------------------------------

test("legacy GET routes default to the only account and accept ?acct=", async () => {
  const res = await get("/messages?group=1%40g.us&n=5");
  assert.deepEqual(await res.json(), { messages: [{ s: "A", t: 1, x: "main:5" }] });
  const explicit = await get("/messages?group=1%40g.us&n=5&acct=main");
  assert.equal(explicit.status, 200);
  assert.equal(await status(get("/messages?group=1%40g.us&acct=nope")), 404);
  assert.equal(await status(get("/messages")), 400, "group is still required");
  assert.deepEqual(await json(get("/members")), { members: [], ready: true });
  assert.deepEqual(await json(get("/export?group=1%40g.us")), {
    messages: [{ s: "A", t: 1, x: "all:main" }],
  });
});

test("legacy routes need acct once there are two accounts", async () => {
  accounts.set("two", fakeAccount("two"));
  try {
    assert.equal(await status(get("/messages?group=1%40g.us")), 400);
    const res = await get("/messages?group=1%40g.us&acct=two");
    assert.deepEqual(await res.json(), { messages: [{ s: "A", t: 1, x: "two:150" }] });
    // POST routes carry acct in the body.
    const send = await call("POST", "/send", { acct: "two", jid: DM, text: "hi" });
    assert.equal(send.status, 200);
    assert.equal(accounts.get("two")?.sends.at(-1)?.jid, DM);
    assert.equal(await status(call("POST", "/send", { jid: DM, text: "hi" })), 400);
  } finally {
    accounts.delete("two");
  }
});

// The Bot's conversational reply arrives on this route, and an eve turn is a
// durable workflow whose steps replay. The key has to reach onSend or the
// dedupe downstream has nothing to work with.
test("POST /send forwards the idempotency key to the account", async () => {
  const res = await call("POST", "/send", {
    idempotencyKey: "whatsapp:turn_1:0",
    jid: DM,
    text: "hi",
  });
  assert.equal(res.status, 200);
  assert.deepEqual(accounts.get("main")?.sends.at(-1), {
    jid: DM,
    key: "whatsapp:turn_1:0",
    text: "hi",
  });
});

test("POST /send treats a blank idempotency key as absent and requires jid and text", async () => {
  await call("POST", "/send", { idempotencyKey: "   ", jid: DM, text: "hi" });
  assert.equal(accounts.get("main")?.sends.at(-1)?.key, undefined);
  assert.equal(await status(call("POST", "/send", { jid: DM })), 400);
});

// A Bot never posts to a group on its own initiative. This is the structural
// backstop: the onSend allowlist is config and fails open if a group jid is
// ever added to owner_jids or digest_recipient_jids.
test("POST /send refuses a group jid before it reaches the account", async () => {
  const count = accounts.get("main")!.sends.length;
  const res = await call("POST", "/send", { jid: "1234567890-987654@g.us", text: "hello all" });
  assert.equal(res.status, 403);
  assert.equal(accounts.get("main")!.sends.length, count);
});

test("POST /send-media validates the payload and permits groups", async () => {
  const ok = await call("POST", "/send-media", {
    base64: "aGk=",
    jid: "1@g.us",
    mime: "image/png",
  });
  assert.deepEqual(await ok.json(), { sent: true });
  assert.equal(
    await status(call("POST", "/send-media", { jid: "1@g.us", mime: "text/plain" })),
    400,
  );
});

test("POST /report, /invite and /backfill validate their bodies", async () => {
  assert.equal(await status(call("POST", "/report", { summary: "add dark mode" })), 200);
  assert.equal(await status(call("POST", "/report", {})), 400);
  assert.equal(
    await status(call("POST", "/invite", { fullName: "Ada", phone: "+61400000000" })),
    200,
  );
  assert.equal(await status(call("POST", "/invite", { fullName: "Ada" })), 400);
  const backfill = await call("POST", "/backfill", { group: "1@g.us", n: 10 });
  assert.deepEqual(await backfill.json(), { anchor: "m1", ok: true, requested: 10 });
  assert.equal(await status(call("POST", "/backfill", {})), 400);
});

test("unknown routes are 404", async () => {
  assert.equal(await status(get("/nope")), 404);
  assert.equal(await status(get("/accounts/main/nope")), 404);
});
