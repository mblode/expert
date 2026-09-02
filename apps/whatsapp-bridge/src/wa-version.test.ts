// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveWaVersion } from "./wa-version.ts";
import type { ResolveWaVersionArgs } from "./wa-version.ts";

const WA_WEB = [2, 3000, 1_044_017_588] as const;
const REPO_PIN = [2, 3000, 1_035_194_821] as const;

const silentLogger = {
  info: () => {
    // silenced in tests
  },
  warn: () => {
    // silenced in tests
  },
} as unknown as ResolveWaVersionArgs["logger"];

const args = (fetchWaWeb: ResolveWaVersionArgs["fetchWaWeb"]): ResolveWaVersionArgs => ({
  fetchBaileys: () => Promise.resolve({ version: [...REPO_PIN] }),
  fetchWaWeb,
  logger: silentLogger,
});

// WhatsApp enforces a minimum version at handshake, so the source that tracks
// what WhatsApp actually runs has to win. The repo pin lagging behind it is what
// took the bridge down with a 405.
test("prefers the version WhatsApp publishes", async () => {
  const resolved = await resolveWaVersion(args(() => Promise.resolve({ version: [...WA_WEB] })));

  assert.deepEqual(resolved.version, [...WA_WEB]);
  assert.equal(resolved.source, "wa-web");
});

test("falls back to the repo pin when the wa-web fetch throws", async () => {
  const resolved = await resolveWaVersion(args(() => Promise.reject(new Error("scrape blocked"))));

  assert.deepEqual(resolved.version, [...REPO_PIN]);
  assert.equal(resolved.source, "baileys-repo");
});

// web.whatsapp.com is scraped, so a shape change yields junk that satisfies the
// declared type rather than throwing. Junk must not reach makeWASocket.
const returning = (version: unknown): ResolveWaVersionArgs["fetchWaWeb"] =>
  (() =>
    Promise.resolve({
      version,
    })) as unknown as ResolveWaVersionArgs["fetchWaWeb"];

test("falls back when wa-web returns too few version parts", async () => {
  const resolved = await resolveWaVersion(args(returning([2, 3000])));

  assert.deepEqual(resolved.version, [...REPO_PIN]);
  assert.equal(resolved.source, "baileys-repo");
});

test("falls back when wa-web returns non-numeric parts", async () => {
  const resolved = await resolveWaVersion(args(returning([2, 3000, "1044017588"])));

  assert.deepEqual(resolved.version, [...REPO_PIN]);
  assert.equal(resolved.source, "baileys-repo");
});

// A total failure should surface, not be swallowed into a bogus default: with
// neither source available there is no version worth guessing.
test("propagates a failure when both sources fail", async () => {
  await assert.rejects(
    resolveWaVersion({
      fetchBaileys: () => Promise.reject(new Error("github down")),
      fetchWaWeb: () => Promise.reject(new Error("scrape blocked")),
      logger: silentLogger,
    }),
    /github down/u,
  );
});
