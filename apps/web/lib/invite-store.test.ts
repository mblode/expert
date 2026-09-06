import { describe, expect, it } from "vitest";

import { mintStoredInvite } from "./invite-store";

/**
 * The caps, against the in-memory database `db.ts` falls back to outside
 * production. Each case gets its own computer id so the ten-minute window is
 * per test rather than per file.
 */
const env = { COMPUTER_SETUP_CODE_VCMC: "setup-code-for-vibey" };

async function mint(sender: string | undefined, now: number) {
  return mintStoredInvite({ kind: "desk", sender }, undefined, env, now, true);
}

describe("mint caps", () => {
  it("stops one sender looping without refusing the next member", async () => {
    const now = Date.UTC(2026, 8, 7, 9, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      expect(await mint("61400000001@s.whatsapp.net", now + i)).not.toHaveProperty("error");
    }
    expect(await mint("61400000001@s.whatsapp.net", now + 3)).toMatchObject({ status: 429 });
    // The member behind them in the queue is unaffected: this is the
    // starvation the per-computer cap alone used to cause.
    expect(await mint("61400000002@s.whatsapp.net", now + 4)).not.toHaveProperty("error");
  });

  it("still bounds the computer when every link comes from a different sender", async () => {
    const now = Date.UTC(2026, 8, 7, 10, 0, 0);
    // An hour after the case above, so its rows are outside this window: the
    // ceiling being measured is what a busy afternoon must not cross, not what
    // one conversation needs.
    let refused = 0;
    for (let i = 0; i < 60; i += 1) {
      const result = await mint(`6140010${String(i).padStart(4, "0")}@s.whatsapp.net`, now + i);
      if ("error" in result) {
        refused += 1;
      }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("does not cap an operator, who holds a session rather than a mint secret", async () => {
    const now = Date.UTC(2026, 8, 7, 11, 0, 0);
    for (let i = 0; i < 10; i += 1) {
      expect(
        await mintStoredInvite({ kind: "desk" }, undefined, env, now + i, false),
      ).not.toHaveProperty("error");
    }
  });
});
