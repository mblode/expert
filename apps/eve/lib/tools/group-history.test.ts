import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTenantData } from "../vibey/test-fixture.ts";
import groupHistory from "./group-history.ts";

const run = (input: { query?: string; person?: string; limit?: number }) =>
  groupHistory.execute(input, {} as never) as Promise<{
    available?: boolean;
    matched: number;
    timeline: { date: string; summary: string; people?: string[] }[];
    context?: Record<string, string>;
  }>;

describe("group-history", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  it("returns the full timeline and context on an unfiltered ask", async () => {
    const res = await run({});
    expect(res.matched).toBe(4);
    expect(res.context?.origin).toBeTruthy();
    expect(res.context?.openai).toBeTruthy();
  });

  it("filters by person and drops context when filtered", async () => {
    const res = await run({ person: "Ben Flint" });
    expect(res.matched).toBe(2);
    expect(res.timeline.every((e) => e.people?.some((p) => p.includes("Ben Flint")))).toBeTruthy();
    expect(res.context).toBeUndefined();
  });

  it("filters the timeline by keyword", async () => {
    const res = await run({ query: "meetup" });
    expect(res.matched).toBe(1);
    expect(res.timeline[0]?.summary.toLowerCase()).toContain("meetup");
  });

  it("respects the limit", async () => {
    const res = await run({ limit: 3 });
    expect(res.timeline).toHaveLength(3);
  });

  it("is unavailable on a computer with no history", async () => {
    cleanup();
    cleanup = installTenantData({ history: { context: {}, timeline: [] } });
    const res = await run({});
    expect(res.available).toBe(false);
  });
});
