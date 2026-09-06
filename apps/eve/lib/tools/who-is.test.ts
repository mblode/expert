import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTenantData } from "../vibey/test-fixture.ts";
import whoIs from "./who-is.ts";

// Off-group context (no group jid) → no bridge call, archive-only. Matches how
// the eve TUI runs, which is the realistic test surface here. The community is
// the fixture: four profiled members and eight archived lines, with one poster
// (Geoff) who has history but no profile.
const ctx = { session: { auth: { current: undefined } } } as never;

const run = (name: string) =>
  whoIs.execute({ name }, ctx) as Promise<{
    found: boolean;
    profile?: { name: string; member?: boolean } | null;
    member?: boolean;
    stats?: {
      messages: number;
      rank: number;
      topics: string[];
      activeFrom: string | null;
      sample?: { text: string };
    } | null;
    query?: string;
    note?: string;
  }>;

describe("who-is", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  it("returns a curated profile plus computed activity for an active member", async () => {
    const res = await run("Marcus");
    expect(res.found).toBeTruthy();
    expect(res.profile?.name).toBe("Marcus Schappi");
    // Marcus is the most active poster in the fixture.
    expect(res.stats?.messages).toBe(4);
    expect(res.stats?.rank).toBe(1);
    expect(Array.isArray(res.stats?.topics)).toBeTruthy();
  });

  it("resolves a member by alias", async () => {
    const res = await run("Benji");
    expect(res.profile?.name).toBe("Ben Simai");
  });

  it("resolves a profiled member with one archived line", async () => {
    const res = await run("Scott Falkner");
    expect(res.found).toBeTruthy();
    expect(res.profile?.name).toBe("Scott Falkner");
    expect(res.member).toBeTruthy();
  });

  it("marks a past participant who isn't on the current roster", async () => {
    const res = await run("Geoff");
    expect(res.found).toBeTruthy();
    expect(res.stats?.messages).toBe(1);
    expect(res.member).toBeFalsy();
  });

  it("reports cleanly when a name is unknown", async () => {
    const res = await run("Definitely Nobody Xyz");
    expect(res.found).toBeFalsy();
    expect(res.note).toBeTruthy();
  });

  it("resolves a member with a profile and archive stats", async () => {
    const res = await run("John Croucher");
    expect(res.found).toBeTruthy();
    expect(res.profile?.name).toBe("John Croucher");
    expect(res.member).toBeTruthy();
    expect(res.stats?.messages).toBe(2);
  });

  it("declines a raw @mention id that didn't resolve to a name", async () => {
    // An unresolved @lid mention leaking through as digits must not be
    // fuzzy-matched to a stranger's archive activity.
    const res = await run("216543000111");
    expect(res.found).toBeFalsy();
    expect(res.stats ?? null).toBeNull();
    expect(res.note).toBeTruthy();
  });

  it("is honest on a computer with no community at all", async () => {
    cleanup();
    cleanup = installTenantData({
      history: { context: {}, timeline: [] },
      members: [],
      messages: [],
    });
    const res = await run("Marcus");
    expect(res.found).toBeFalsy();
    expect(res.note).toBeTruthy();
  });
});
