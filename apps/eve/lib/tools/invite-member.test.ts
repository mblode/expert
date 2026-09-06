import { describe, expect, it } from "vitest";

import inviteMember from "./invite-member.ts";

// Off-bridge context (no BRIDGE_URL / secret), the way the eve TUI runs. The
// tool should degrade to { available: false } rather than throw, matching the
// other bridge-backed tools.
const ctx = { session: { auth: { current: undefined } } } as never;

describe("invite-member", () => {
  it("degrades gracefully without the bridge rather than throwing", async () => {
    const res = (await inviteMember.execute(
      { fullName: "Jane Doe", phone: "+61400000000" },
      ctx,
    )) as { available?: boolean; note?: string; invited?: boolean };
    // No bridge configured (eve TUI / test env): available:false. If a bridge
    // env leaks into CI the call fails closed with invited:false; either way it
    // never delivers and never throws.
    expect(res.available === false || res.invited === false).toBeTruthy();
  });
});
