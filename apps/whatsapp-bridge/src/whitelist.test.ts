// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { createLiveRoster } from "./live-members.ts";
import { createWhitelist } from "./whitelist.ts";
import type { LiveAllowlist } from "./whitelist.ts";

const silent = {
  info: () => {
    // silenced in tests
  },
} as unknown as Parameters<typeof createWhitelist>[0];

const liveOf = (opts: { phones?: string[]; lids?: string[]; ready?: boolean }): LiveAllowlist => ({
  lids: () => opts.lids ?? [],
  phones: () => opts.phones ?? [],
  ready: () => opts.ready ?? true,
});

test("a live participant is a member, a git-only number is not", () => {
  const whitelist = createWhitelist(silent, liveOf({ phones: ["61411111111"] }));
  assert.equal(whitelist.isMember("+61411111111"), true);
  assert.equal(whitelist.isMember("0411111111"), true);
  assert.equal(whitelist.isMember("61411111111@s.whatsapp.net"), true);
  // Overlay-only (left, or never joined) must not pass the DM gate.
  assert.equal(whitelist.isMember("61408461216"), false);
});

test("a live lid is a member even without a phone", () => {
  const whitelist = createWhitelist(silent, liveOf({ lids: ["216543000111"] }));
  assert.equal(whitelist.isMember("216543000111"), true);
  assert.equal(whitelist.isMember("216543000111@lid"), true);
  assert.equal(whitelist.isMember("999"), false);
});

test("a leaver dropped from the live set loses DM access", () => {
  const live = createLiveRoster();
  live.upsert("g@g.us", { lid: "2", phone: "61411111111" });
  live.markSeeded();
  const whitelist = createWhitelist(silent, {
    lids: () => live.lids(),
    phones: () => live.phones(),
    ready: () => live.ready(),
  });
  assert.equal(whitelist.isMember("61411111111"), true);
  live.remove("g@g.us", { phone: "61411111111" });
  assert.equal(whitelist.isMember("61411111111"), false);
});

test("a joiner is admitted before any git overlay exists", () => {
  const live = createLiveRoster();
  live.markSeeded();
  const whitelist = createWhitelist(silent, {
    lids: () => live.lids(),
    phones: () => live.phones(),
    ready: () => live.ready(),
  });
  assert.equal(whitelist.isMember("61422222222"), false);
  live.upsert("g@g.us", { name: "Finlay", phone: "61422222222" });
  assert.equal(whitelist.isMember("61422222222"), true);
});

test("ready follows the live set: empty until seeded or loaded", () => {
  const live = createLiveRoster();
  const whitelist = createWhitelist(silent, {
    lids: () => live.lids(),
    phones: () => live.phones(),
    ready: () => live.ready(),
  });
  assert.equal(whitelist.ready(), false);
  live.load({ "g@g.us": [{ phone: "61411111111" }] });
  assert.equal(whitelist.ready(), true);
});
