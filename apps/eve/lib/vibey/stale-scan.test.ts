import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, it, expect } from "vitest";

import { installTenantData } from "./test-fixture.ts";

import type { RosterEntry } from "./roster.ts";
import { scanForStaleFacts } from "./stale-scan.js";
import type { StaleScanArgs, RecentMessage } from "./stale-scan.js";

const ROSTER: RosterEntry[] = [
  {
    name: "Aaron Vanston",
    org: "BuildPass",
    role: "Co-Founder & CTO",
    tags: [],
  },
  { name: "Marcus Schappi", org: "Ninja.ai", tags: [] },
];

const msg = (n: string, x: string, t = 1_750_000_000): RecentMessage => ({
  n,
  s: n.toLowerCase().replaceAll(/\s+/gu, ""),
  t,
  x,
});

const base = (overrides: Partial<StaleScanArgs> = {}): StaleScanArgs => ({
  // non-empty = "seen"
  archiveSearch: () => [{ date: "z", from: "x", text: "y" }],
  membersMemory: "",
  recent: [],
  recurringTopicsMemory: "",
  roster: ROSTER,
  ...overrides,
});

describe(scanForStaleFacts, () => {
  // `isKnownMember` reads the member overlay off the tenant data directory.
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => cleanup());

  it("flags a possible role/org change from a change cue", () => {
    const findings = scanForStaleFacts(
      base({
        recent: [msg("Someone", "heard Aaron is now at a brand new startup")],
      }),
    );
    const f = findings.find((x) => x.kind === "role_changed");
    expect(f?.subject).toBe("Aaron Vanston");
    expect(f?.current).toContain("BuildPass");
    expect(f?.evidence.length).toBeGreaterThan(0);
  });

  it("flags an active sender who isn't on the roster", () => {
    const findings = scanForStaleFacts(
      base({
        recent: [
          msg("Brand Newperson", "hey all, just joined the group"),
          msg("Brand Newperson", "loving the chat"),
        ],
      }),
    );
    const f = findings.find((x) => x.kind === "unknown_active");
    expect(f?.subject).toBe("Brand Newperson");
    // 2 messages
    expect(f?.confidence).toBe("med");
  });

  it("does not flag a roster member as unknown", () => {
    const findings = scanForStaleFacts(base({ recent: [msg("Marcus Schappi", "hello")] }));
    expect(findings.some((x) => x.kind === "unknown_active")).toBeFalsy();
  });

  it("flags a roster member with no recent or archive presence as possibly left", () => {
    const findings = scanForStaleFacts(
      base({
        archiveSearch: (q) => (q.includes("Aaron") ? [] : [{ date: "z", from: "x", text: "y" }]),
        recent: [msg("Marcus Schappi", "still here")],
      }),
    );
    const f = findings.find((x) => x.kind === "possibly_left");
    expect(f?.subject).toBe("Aaron Vanston");
  });

  it("flags a frequent new term missing from recurring topics", () => {
    // 8 mentions: below that, a day's traffic surfaces ordinary English verbs
    // rather than themes (the first live run proposed "talk" and "been").
    const recent = Array.from({ length: 9 }, (_, i) =>
      msg("Someone", `the new gpt6launch model thread number ${i}`),
    );
    const findings = scanForStaleFacts(base({ recent, recurringTopicsMemory: "model launches" }));
    const f = findings.find((x) => x.kind === "new_recurring_topic" && x.subject === "gpt6launch");
    expect(f).toBeDefined();
  });

  it("does not flag a term already in recurring topics", () => {
    const recent = Array.from({ length: 6 }, () => msg("Someone", "factorio factorio talk"));
    const findings = scanForStaleFacts(
      base({ recent, recurringTopicsMemory: "factorio not starcraft" }),
    );
    expect(
      findings.some((x) => x.kind === "new_recurring_topic" && x.subject === "factorio"),
    ).toBeFalsy();
  });
});

describe("proposed text is memory, not a work order", () => {
  /**
   * Every `proposed` string is appended verbatim into `<group_memory>`, which
   * the model reads as standing facts about the group. The original templates
   * were written for an admin's eyes ("Verify X is still active") and spent
   * five nights accumulating imperative sentences in the system prompt telling
   * a human to go and edit it.
   *
   * Asserted against the source rather than a scan run, so a fifth signal added
   * later is covered without anyone remembering to build a fixture for it.
   */
  const IMPERATIVE =
    /^(?:check|verify|consider|confirm|review|update|add|remove|ask|make sure|please|ensure|note that)\b/iu;

  it("has no imperative template", () => {
    const source = readFileSync(new URL("stale-scan.ts", import.meta.url), "utf-8");
    const templates = [...source.matchAll(/^\s*proposed: `(?<template>.+)`,$/gmu)].map(
      (m) => m.groups?.template ?? "",
    );

    expect(templates.length).toBeGreaterThanOrEqual(4);
    for (const t of templates) {
      // Strip a leading `${...}` interpolation so the first real word is tested.
      expect(t.replace(/^\$\{[^}]+\}\s*/u, "")).not.toMatch(IMPERATIVE);
    }
  });
});
