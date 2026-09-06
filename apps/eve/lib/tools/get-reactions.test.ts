import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installTenantData } from "../vibey/test-fixture.ts";

import type { ReactedMessage } from "../vibey/reactions.ts";
import getReactions, { dedupTop, topKey } from "./get-reactions.ts";

// Off-group context (no group jid) → no bridge call, archive-only baked
// reactions. Matches how the eve TUI runs and mirrors the who-is test setup.
const ctx = { session: { auth: { current: undefined } } } as never;

const msg = (over: Partial<ReactedMessage>): ReactedMessage => ({
  emojis: { "🔥": over.reactions ?? 1 },
  from: "Alice",
  reactions: 1,
  text: "gm",
  ...over,
});

describe("get-reactions dedupTop", () => {
  it("keeps same-author/same-text messages on different dates separate", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 2 }),
      msg({ date: "2/3/2025", reactions: 5 }),
    ]);
    // Distinct days ⇒ two distinct keys ⇒ both survive (not collapsed).
    expect(map.size).toBe(2);
    const counts = [...map.values()].map((m) => m.reactions).toSorted();
    expect(counts).toStrictEqual([2, 5]);
  });

  it("merges identical date+author+text, keeping the higher count", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 2 }),
      msg({ date: "1/3/2025", reactions: 7 }),
    ]);
    expect(map.size).toBe(1);
    expect([...map.values()][0].reactions).toBe(7);
  });

  it("does not let a later, lower count overwrite the higher one", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", reactions: 9 }),
      msg({ date: "1/3/2025", reactions: 3 }),
    ]);
    expect([...map.values()][0].reactions).toBe(9);
  });

  it("treats a missing date distinctly from a dated row", () => {
    const dated = msg({ date: "1/3/2025" });
    const undated = msg({ date: undefined });
    expect(topKey(dated)).not.toBe(topKey(undated));
    expect(dedupTop([dated, undated]).size).toBe(2);
  });

  it("distinguishes different authors and different text", () => {
    const map = dedupTop([
      msg({ date: "1/3/2025", from: "Alice", text: "gm" }),
      msg({ date: "1/3/2025", from: "Bob", text: "gm" }),
      msg({ date: "1/3/2025", from: "Alice", text: "gn" }),
    ]);
    expect(map.size).toBe(3);
  });
});

describe("get-reactions tool (archive-only)", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  interface ReactionsResult {
    available: boolean;
    top: ReactedMessage[];
    byEmoji: Record<string, number>;
    totalReactions: number;
    liveError?: string;
  }

  it("returns baked reactions ranked, available off-bridge", async () => {
    const res = (await getReactions.execute({ limit: 5 }, ctx)) as ReactionsResult;
    // Baked archive carries reactions, so the tool is available with no bridge.
    expect(res.available).toBeTruthy();
    expect(res.liveError).toBeUndefined();
    expect(res.top.length).toBeGreaterThan(0);
    expect(res.top.length).toBeLessThanOrEqual(5);
    expect(res.totalReactions).toBeGreaterThan(0);
  });

  it("ranks reactions descending with no duplicate rows", async () => {
    const res = (await getReactions.execute({ limit: 5 }, ctx)) as ReactionsResult;
    // top is sorted by reaction count, descending.
    for (let i = 1; i < res.top.length; i += 1) {
      expect(res.top[i].reactions).toBeLessThanOrEqual(res.top[i - 1].reactions);
    }
    // No two returned rows share a dedup key.
    const keys = res.top.map(topKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
