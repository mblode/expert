import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTenantData } from "../vibey/test-fixture.ts";

import getGroupStats from "./get-group-stats.ts";

// Off-group context (no group jid) → no bridge call, archive-only. Matches how
// the eve TUI runs and mirrors the who-is test setup.
const ctx = { session: { auth: { current: undefined } } } as never;

interface Sender {
  from: string;
  count: number;
  rank: number;
}

const run = (input: { limit?: number; sender?: string }) =>
  getGroupStats.execute(input, ctx) as Promise<{
    participants: number;
    total: number;
    topSenders?: Sender[];
    matches?: Sender[];
    query?: string;
  }>;

describe("get-group-stats", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  it("ranks senders by message count, descending, with sequential ranks", async () => {
    const res = await run({ limit: 5 });
    const top = res.topSenders ?? [];
    expect(top.length).toBeGreaterThan(0);
    expect(top.length).toBeLessThanOrEqual(5);
    // Counts are real volume: strictly non-increasing down the leaderboard.
    for (let i = 1; i < top.length; i += 1) {
      expect(top[i].count).toBeLessThanOrEqual(top[i - 1].count);
    }
    // Ranks are 1-based and sequential.
    for (let i = 0; i < top.length; i += 1) {
      expect(top[i].rank).toBe(i + 1);
    }
    expect(top[0].count).toBeGreaterThan(0);
  });

  it("totals and participants are consistent with the leaderboard", async () => {
    const res = await run({ limit: 50 });
    expect(res.total).toBeGreaterThan(0);
    expect(res.participants).toBeGreaterThan(0);
    // Every leaderboard count is part of the total, so the top sender alone
    // can't exceed the grand total.
    expect((res.topSenders ?? [])[0].count).toBeLessThanOrEqual(res.total);
  });

  it("honours the limit", async () => {
    const res = await run({ limit: 3 });
    expect(res.topSenders).toHaveLength(3);
  });

  it("is unavailable on a computer with no archive", async () => {
    cleanup();
    cleanup = installTenantData({ messages: [] });
    const res = (await run({ limit: 3 })) as unknown as { available?: boolean };
    expect(res.available).toBe(false);
  });

  it("looks up a single sender by substring with their global rank", async () => {
    const res = await run({ sender: "Marcus" });
    const matches = res.matches ?? [];
    expect(res.query).toBe("Marcus");
    expect(matches.length).toBeGreaterThan(0);
    const [m] = matches;
    expect(m.from.toLowerCase()).toContain("marcus");
    expect(m.count).toBeGreaterThan(0);
    // Rank is the person's position in the all-time leaderboard, not 1.
    expect(m.rank).toBeGreaterThanOrEqual(1);
  });

  it("no longer returns a range field", async () => {
    const top = await run({ limit: 1 });
    expect(top).not.toHaveProperty("range");
    const sender = await run({ sender: "Marcus" });
    expect(sender).not.toHaveProperty("range");
  });
});
