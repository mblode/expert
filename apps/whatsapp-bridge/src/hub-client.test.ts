// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { createChannelClient } from "./hub-client.ts";
import type { AskAgentArgs } from "./hub-client.ts";

const noopLogger = {
  warn: () => {
    // silenced in tests
  },
} as unknown as Parameters<typeof createChannelClient>[0]["logger"];

const baseArgs: AskAgentArgs = {
  message: "hello",
  sender: "61456455551@s.whatsapp.net",
  senderName: "Matt",
  senderPhone: "61456455551",
  surface: "dm",
  token: "61456455551@s.whatsapp.net",
};

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

const withStubbedFetch = async (
  responses: (() => Response)[],
  fn: (captured: Captured[]) => Promise<void>,
): Promise<void> => {
  const captured: Captured[] = [];
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = ((url: unknown, init?: RequestInit) => {
    captured.push({
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
      url: String(url),
    });
    const make = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return Promise.resolve(make());
  }) as typeof fetch;
  try {
    await fn(captured);
  } finally {
    globalThis.fetch = original;
  }
};

const makeClient = (maxAttempts?: number) =>
  createChannelClient({
    acct: "main",
    channelSecret: "s3cret",
    endpoint: "http://127.0.0.1:8080/channels/whatsapp-main/message",
    logger: noopLogger,
    maxAttempts,
    sleep: async () => {
      // no backoff in tests
    },
    timeoutMs: 1000,
  });

// The hub matches x-channel-secret against channels.json; the acct rides in
// the body so one Bot on two numbers can tell them apart.
test("askAgent posts to the channel ingress with the channel secret and acct", async () => {
  await withStubbedFetch([() => Response.json({ reply: " hi there " })], async (captured) => {
    const ask = makeClient();
    const result = await ask(baseArgs);
    assert.equal(result.reply, "hi there");
    assert.equal(captured[0]?.url, "http://127.0.0.1:8080/channels/whatsapp-main/message");
    assert.equal(captured[0]?.headers["x-channel-secret"], "s3cret");
    assert.equal("x-bridge-secret" in (captured[0]?.headers ?? {}), false);
    assert.equal(captured[0]?.body.acct, "main");
    assert.equal(captured[0]?.body.token, baseArgs.token);
  });
});

test("askAgent returns an empty reply when the Bot sends none", async () => {
  await withStubbedFetch([() => Response.json({})], async () => {
    const ask = makeClient();
    const result = await ask(baseArgs);
    assert.equal(result.reply, "");
  });
});

test("askAgent retries transient failures up to the default 3 attempts", async () => {
  await withStubbedFetch(
    [
      () => new Response("boom", { status: 500 }),
      () => new Response("boom", { status: 500 }),
      () => Response.json({ reply: "third time lucky" }),
    ],
    async (captured) => {
      const ask = makeClient();
      const result = await ask(baseArgs);
      assert.equal(result.reply, "third time lucky");
      assert.equal(captured.length, 3);
    },
  );
});

test("askAgent honors maxAttempts=1", async () => {
  await withStubbedFetch(
    [() => new Response("boom", { status: 500 }), () => Response.json({ reply: "would-be retry" })],
    async (captured) => {
      const ask = makeClient(1);
      await assert.rejects(() => ask(baseArgs), /hub responded 500/u);
      assert.equal(captured.length, 1);
    },
  );
});

test("askAgent fails fast on non-retryable 4xx", async () => {
  await withStubbedFetch([() => new Response("nope", { status: 401 })], async (captured) => {
    const ask = makeClient();
    await assert.rejects(() => ask(baseArgs), /hub responded 401/u);
    assert.equal(captured.length, 1);
  });
});
