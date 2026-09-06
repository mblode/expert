import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTenantData } from "../vibey/test-fixture.ts";

import searchChat from "./search-chat.ts";

// Off-group context (no group jid) → no bridge call, archive-only. Matches how
// the eve TUI runs, which is the realistic test surface here.
const ctx = { session: { auth: { current: undefined } } } as never;

interface Result {
  matched: number;
  results: { from: string; text: string; score: number }[];
}

const run = (input: { query: string; limit?: number; sender?: string }) =>
  searchChat.execute(input, ctx) as Promise<Result>;

describe("search-chat", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  it("reports the true total in `matched` while capping `results` at limit", async () => {
    // "claude" is in five of the eight fixture lines.
    const res = await run({ limit: 3, query: "claude" });
    expect(res.results).toHaveLength(3);
    expect(res.matched).toBeGreaterThan(3);
  });

  it("counts only the filtered sender's messages when `sender` is set", async () => {
    const res = await run({ query: "claude", sender: "Marcus" });
    expect(res.matched).toBeGreaterThanOrEqual(res.results.length);
    for (const r of res.results) {
      expect(r.from.toLowerCase()).toContain("marcus");
    }
    // The sender filter must narrow the count, not just the page.
    const all = await run({ query: "claude" });
    expect(res.matched).toBeLessThan(all.matched);
  });

  it("returns zero matched and no results for a nonsense query", async () => {
    const res = await run({ query: "xyzzyplughfrobozz" });
    expect(res.matched).toBe(0);
    expect(res.results).toStrictEqual([]);
  });

  it("is unavailable on a computer with no archive", async () => {
    cleanup();
    cleanup = installTenantData({ messages: [] });
    const res = (await run({ query: "claude" })) as unknown as { available?: boolean };
    expect(res.available).toBe(false);
  });
});
