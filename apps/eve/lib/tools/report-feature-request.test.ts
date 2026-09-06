import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import reportFeatureRequest from "./report-feature-request.ts";

// Off-bridge context (no BRIDGE_URL / secret), the way the eve TUI runs. The
// tool should degrade to { available: false } rather than throw, matching the
// other bridge-backed tools.
const ctx = { session: { auth: { current: undefined } } } as never;

const src = readFileSync(new URL("report-feature-request.ts", import.meta.url), "utf-8");

describe("report-feature-request", () => {
  it("degrades gracefully without the bridge rather than throwing", async () => {
    const res = (await reportFeatureRequest.execute(
      { kind: "feature", summary: "annual vcmc awards night" },
      ctx,
    )) as { available?: boolean; note?: string; reported?: boolean };
    // No bridge configured (eve TUI / test env): available:false. If a bridge
    // env leaks into CI the call fails closed with reported:false; either way
    // it never delivers and never throws.
    expect(res.available === false || res.reported === false).toBeTruthy();
  });

  it("advertises VCMC/group ideas, not just vibey-the-agent features", () => {
    // The description is the always-on gate. The first cut said "about @vibey
    // (the agent)" and "only when someone clearly asks for a new capability",
    // which is what bounced the awards-night ask. Pin the wider scope here so
    // a later edit can't silently re-narrow it; the routing eval is the other
    // half.
    expect(src).toMatch(/VCMC \/ the group/u);
    expect(src).toMatch(/not a vibey feature/u);
    expect(src).toMatch(/just a joke/u);
    expect(src).not.toMatch(/Use it only when someone clearly asks for a new capability/u);
    expect(src).not.toMatch(/Skip only jokes and compliments/u);
  });
});
