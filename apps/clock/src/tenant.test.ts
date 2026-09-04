import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTargets, Tenant } from "./tenant.ts";

interface Call {
  url: string;
}

function tenant(opts: {
  now: () => number;
  reply: () => { ok: boolean; body: unknown } | Error;
  calls: Call[];
  holdMs?: number;
  maxHoldMs?: number;
}): Tenant {
  return new Tenant({
    busyGraceMs: 5000,
    fetchImpl: ((url: string) => {
      opts.calls.push({ url });
      const reply = opts.reply();
      if (reply instanceof Error) {
        return Promise.reject(reply);
      }
      return Promise.resolve({
        json: () => Promise.resolve(reply.body),
        ok: reply.ok,
        status: reply.ok ? 200 : 502,
      } as Response);
    }) as unknown as typeof fetch,
    holdMs: opts.holdMs ?? 1000,
    maxHoldMs: opts.maxHoldMs ?? 8000,
    name: "box",
    now: opts.now,
    timeoutMs: 1000,
    url: "https://box.fly.dev/",
  });
}

test("nothing is pinged until a routine is due", async () => {
  const calls: Call[] = [];
  const t = tenant({ calls, now: () => 0, reply: () => ({ body: {}, ok: true }) });
  await t.poll();
  assert.deepEqual(calls, []);
  assert.equal(t.holding(), false);

  t.wake("morning-brief");
  await t.poll();
  assert.deepEqual(calls, [{ url: "https://box.fly.dev/healthz" }]);
});

test("a box that says it is busy keeps the Machine up past the wake window", async () => {
  const calls: Call[] = [];
  let now = 0;
  const t = tenant({ calls, now: () => now, reply: () => ({ body: { busy: true }, ok: true }) });
  t.wake("morning-brief");
  // The wake alone would let it suspend again at 1000.
  assert.equal(t.holding(1500), false);
  await t.poll();
  assert.equal(t.holding(1500), true);
  assert.equal(t.status().box_busy, true);

  // And it keeps extending while the turn runs, one grace period at a time.
  now = 4000;
  await t.poll();
  assert.equal(t.holding(8500), false, "the deadline still caps it");
  assert.equal(t.holding(7999), true);
});

test("a busy box never gets a shorter hold than the wake alone gave it", async () => {
  const calls: Call[] = [];
  // The grace is shorter than the wake window, which is the case where
  // assigning rather than extending would cut the hold short.
  const t = tenant({
    calls,
    holdMs: 9000,
    maxHoldMs: 20_000,
    now: () => 0,
    reply: () => ({ body: { busy: true }, ok: true }),
  });
  t.wake("morning-brief");
  await t.poll();
  assert.equal(t.holding(8999), true, "the busy answer must not shorten the window");
});

test("a busy box cannot hold the Machine up forever", async () => {
  const calls: Call[] = [];
  let now = 0;
  const t = tenant({
    calls,
    maxHoldMs: 2000,
    now: () => now,
    reply: () => ({ body: { busy: true }, ok: true }),
  });
  t.wake("morning-brief");
  now = 500;
  await t.poll();
  assert.equal(t.holding(1999), true);
  assert.equal(t.holding(2000), false, "maxHoldMs is the backstop for a stuck marker");
});

test("a failed ping is recorded and retried, not thrown", async () => {
  const calls: Call[] = [];
  let fail = true;
  const t = tenant({
    calls,
    now: () => 0,
    reply: () => (fail ? new Error("machine did not resume") : { body: { busy: false }, ok: true }),
  });
  t.wake("morning-brief");
  await t.poll();
  assert.match(t.status().last_result, /machine did not resume/u);
  assert.equal(t.status().failures, 1);

  fail = false;
  await t.poll();
  assert.equal(t.status().failures, 0);
  assert.equal(calls.length, 2, "the next tick is still inside the hold window");
});

test("a body that is not the hub's is not busy", async () => {
  const calls: Call[] = [];
  const t = tenant({
    calls,
    now: () => 0,
    // What a proxy error page parses to, or does not.
    reply: () => ({ body: "<html>bad gateway</html>", ok: false }),
  });
  t.wake("morning-brief");
  await t.poll();
  assert.equal(t.status().box_busy, false);
  assert.equal(t.status().failures, 1);
});

test("targets are named pairs, bare URLs, or dropped", () => {
  const warnings: string[] = [];
  assert.deepEqual(
    parseTargets(
      "mblode=https://mblode-computer.fly.dev, https://vcmc-computer.fly.dev ftp://nope not-a-url",
      (line) => warnings.push(line),
    ),
    [
      { name: "mblode", url: "https://mblode-computer.fly.dev" },
      { name: "vcmc-computer.fly.dev", url: "https://vcmc-computer.fly.dev" },
    ],
  );
  assert.equal(warnings.length, 2);
  assert.deepEqual(parseTargets(undefined), []);
});
