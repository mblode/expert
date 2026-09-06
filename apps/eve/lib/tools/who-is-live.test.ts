import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PersonProfile } from "../vibey/data/people.ts";
import { fetchLiveMembers } from "../vibey/live-members.ts";
import { installTenantData } from "../vibey/test-fixture.ts";
import whoIs from "./who-is.ts";

vi.mock(import("../vibey/live-members.ts"), () => ({
  fetchLiveMembers: vi.fn<() => Promise<PersonProfile[] | null>>().mockResolvedValue(null),
}));

const ctx = { session: { auth: { current: undefined } } } as never;

const run = (name: string) =>
  whoIs.execute({ name }, ctx) as Promise<{
    found: boolean;
    profile?: { name: string; tags?: string[] } | null;
    member?: boolean;
    note?: string;
  }>;

describe("who-is against the live member list", () => {
  let cleanup: () => void;
  beforeEach(() => {
    cleanup = installTenantData();
  });
  afterEach(() => {
    cleanup();
    vi.mocked(fetchLiveMembers).mockResolvedValue(null);
  });

  it("treats a live-only joiner as a current member", async () => {
    vi.mocked(fetchLiveMembers).mockResolvedValue([
      { name: "Finlay", phone: "+61411111111", tags: ["unidentified"] },
    ]);
    const res = await run("Finlay");
    expect(res.found).toBeTruthy();
    expect(res.member).toBeTruthy();
    expect(res.profile?.tags).toContain("unidentified");
  });

  it("treats an overlay-only profile as having left when they are not live", async () => {
    vi.mocked(fetchLiveMembers).mockResolvedValue([
      { name: "Finlay", phone: "+61411111111", tags: ["unidentified"] },
    ]);
    const res = await run("Marcus Schappi");
    expect(res.found).toBeTruthy();
    expect(res.member).toBeFalsy();
    expect(res.note).toMatch(/left/iu);
  });
});
