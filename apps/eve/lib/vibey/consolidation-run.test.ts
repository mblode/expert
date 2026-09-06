import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bridgeGet } from "./bridge-client.ts";
import { mutateJson, readGroupMemory, readMemoryWrites } from "./memory-store.ts";

import { consolidationHour, runConsolidation } from "./consolidation-run.js";
import type * as MemoryStore from "./memory-store.js";
import type { GroupMemory } from "./memory-store.js";

type AsyncStub = (...args: never[]) => Promise<unknown>;

// `bridgeGet` and `mutateJson` are generic (`<T>(…) => Promise<T>`), which no
// concrete stub signature satisfies — `Promise<unknown>` is not assignable to a
// caller-chosen `Promise<T>`. Hence the casts. They are type-only, so they
// survive the hoisting these factories get, and `vi.mocked()` at the call sites
// still types against the real declarations.

// The run touches the bridge, Blob and the deep archive. Stubbing all three
// keeps this about the wiring — that a finished run always carries a tripwire
// verdict — rather than about what the committed archive happens to contain.
vi.mock(import("./bridge-client.ts"), () => ({
  bridgeConfigured: () => true,
  bridgeGet: vi.fn<AsyncStub>() as unknown as typeof bridgeGet,
}));

vi.mock(import("./memory-store.ts"), async (importOriginal) => ({
  ...(await importOriginal<typeof MemoryStore>()),
  appendMemoryWrites: vi.fn<() => Promise<void>>(() => Promise.resolve()),
  blobConfigured: () => true,
  mutateJson: vi.fn<AsyncStub>() as unknown as typeof mutateJson,
  readGroupMemory: vi.fn<AsyncStub>() as unknown as typeof readGroupMemory,
  readMemoryWrites: vi.fn<AsyncStub>() as unknown as typeof readMemoryWrites,
}));

// Every roster member has archive hits, so `possibly_left` never fires and the
// findings are determined solely by the message window this test supplies.
vi.mock(import("./archive-search.ts"), () => ({
  archiveSearch: () => [{ date: "1/1/2026", from: "someone", text: "hi" }],
}));

const KEY = "MEMORY_CONSOLIDATION_HOUR";
let saved: string | undefined;

describe(consolidationHour, () => {
  beforeEach(() => {
    saved = process.env[KEY];
    // Reflect.deleteProperty, not `= undefined`: assigning undefined stores the
    // literal string "undefined" in process.env, which reads as a set value.
    Reflect.deleteProperty(process.env, KEY);
  });

  afterEach(() => {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, KEY);
    } else {
      process.env[KEY] = saved;
    }
  });

  it("defaults to 16 UTC (~3am Melbourne)", () => {
    expect(consolidationHour()).toBe(16);
  });

  it("accepts a valid hour", () => {
    process.env[KEY] = "2";
    expect(consolidationHour()).toBe(2);
  });

  it("falls back rather than firing at a nonsense hour", () => {
    // A typo must not mean "every hour" or "never" — it means the default.
    process.env[KEY] = "25";
    expect(consolidationHour()).toBe(16);
    process.env[KEY] = "not-a-number";
    expect(consolidationHour()).toBe(16);
  });
});

describe(runConsolidation, () => {
  const now = new Date("2026-08-05T16:00:00Z");
  const at = (offsetHours: number): number => Math.floor(now.getTime() / 1000) - offsetHours * 3600;

  beforeEach(() => {
    vi.mocked(readGroupMemory).mockResolvedValue({});
    vi.mocked(readMemoryWrites).mockResolvedValue([]);
    vi.mocked(bridgeGet).mockResolvedValue({ messages: [] });
    // Stand in for Blob: apply the mutation and hand back the result, which is
    // what the shape and append-only invariants are checked against.
    vi.mocked(mutateJson).mockImplementation((_key, mutate) =>
      Promise.resolve((mutate as (c: GroupMemory | null) => GroupMemory)({})),
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("carries a tripwire verdict even on a night that wrote nothing", () =>
    // The empty-night path used to return early. A run of empty nights is
    // itself an invariant, so it is the one path that must not skip the check.
    expect(runConsolidation({ groupJid: "123@g.us", now })).resolves.toMatchObject({
      applied: 0,
      ran: true,
      tripwires: { ok: true, violations: [] },
    }));

  it("passes its own writes through the invariants", async () => {
    // Five messages from someone off the roster is a `unknown_active` finding,
    // which is the cheapest way to make the run actually write something.
    vi.mocked(bridgeGet).mockResolvedValue({
      messages: Array.from({ length: 5 }, (_, i) => ({
        n: "Nella Newcomer",
        s: "61400000001@s.whatsapp.net",
        t: at(i + 1),
        x: `hello everyone ${i}`,
      })),
    });

    const result = await runConsolidation({ groupJid: "123@g.us", now });

    expect(result.applied).toBeGreaterThan(0);
    expect(result.tripwires).toStrictEqual({ ok: true, violations: [] });
  });

  it("reports a violation when the write does not land", async () => {
    // A lost write is the failure the nightly log would report as a success.
    vi.mocked(bridgeGet).mockResolvedValue({
      messages: Array.from({ length: 5 }, (_, i) => ({
        n: "Nella Newcomer",
        s: "61400000001@s.whatsapp.net",
        t: at(i + 1),
        x: `hello everyone ${i}`,
      })),
    });
    vi.mocked(mutateJson).mockResolvedValue({});

    const result = await runConsolidation({ groupJid: "123@g.us", now });

    expect(result.tripwires?.ok).toBeFalsy();
    expect(result.tripwires?.violations.join("\n")).toContain("not in memory.members");
  });

  it("skips the run entirely when the bridge or blob is unconfigured", async () => {
    // Degrade rather than throw — the eve TUI and a bare checkout both hit this.
    vi.resetModules();
    vi.doMock(import("./bridge-client.ts"), () => ({
      bridgeConfigured: () => false,
      bridgeGet: vi.fn<AsyncStub>() as unknown as typeof bridgeGet,
    }));
    const fresh = await import("./consolidation-run.js");

    await expect(fresh.runConsolidation({ groupJid: "123@g.us", now })).resolves.toMatchObject({
      applied: 0,
      ran: false,
    });

    vi.doUnmock("./bridge-client.ts");
    vi.resetModules();
  });
});
