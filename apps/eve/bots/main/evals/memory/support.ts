import { randomUUID } from "node:crypto";

import { clearMemoryFixture } from "../support/fixtures.ts";
import { EVAL_AUTH_HEADERS } from "../../../../lib/vibey/eval-auth.ts";
import type { GroupMemory, MemoryWrite } from "../../../../lib/vibey/memory-store.ts";
import { appendMemoryWrites, memoryKey, mutateJson } from "../../../../lib/vibey/memory-store.ts";

/**
 * Helpers shared by the memory-security evals (MESR and SRSR).
 *
 * `evals/support/fixtures.ts` covers the common case — seed a group's memory,
 * run a turn against it, delete it. Two things it deliberately doesn't do are
 * needed here, so they live in this sibling rather than widening that module:
 *
 *   1. **A DM-shaped JID.** Memory is keyed by chat JID, so a DM fixture is
 *      structurally unable to reach the real group's memory however the run
 *      goes. That mattered more when `canSaveMemory` admin-gated `@g.us`
 *      writes and no eval could authorise a revert; the gate is gone now, and
 *      the DM JID stays for the containment, not the permission.
 *   2. **A seeded audit trail.** A revert works from the write log, not from
 *      memory, so an SRSR fixture has to plant the `MemoryWrite` entries that
 *      the overnight pass would have left behind.
 */

/** The identity an eval sends as. All three fields are optional to the seam. */
export interface EvalSender {
  /** Sender JID; becomes the session principal. */
  sender?: string;
  senderName?: string;
  /**
   * Phone identity. Nothing gates on it now that memory is ungated, but the
   * bridge still sends it and a fixture that omitted it would exercise a
   * message shape production never produces.
   */
  senderPhone?: string;
}

/**
 * An ordinary member. The `@lid` principal with a separate phone identity is
 * what modern WhatsApp actually delivers, so an eval that used only one of the
 * two would exercise a shape the bridge never sends.
 */
export const MEMBER: EvalSender = {
  sender: "8888888888888888@lid",
  senderName: "Dana Whitlock",
  senderPhone: "61400000000@s.whatsapp.net",
};

/** Request headers that put `jid` and `who` on the session. See `eval-auth.ts`. */
export const evalHeaders = (jid: string, who: EvalSender = MEMBER): Record<string, string> => ({
  [EVAL_AUTH_HEADERS.chatJid]: jid,
  ...(who.sender ? { [EVAL_AUTH_HEADERS.sender]: who.sender } : {}),
  ...(who.senderName ? { [EVAL_AUTH_HEADERS.senderName]: who.senderName } : {}),
  ...(who.senderPhone ? { [EVAL_AUTH_HEADERS.senderPhone]: who.senderPhone } : {}),
});

/**
 * The same guard `withMemoryFixture` carries: `BLOB_READ_WRITE_TOKEN` points at
 * the production store, so an unprefixed fixture writes into somebody's real
 * memory and teardown is best-effort.
 */
const requirePrefix = (): void => {
  if (!process.env.MEMORY_BLOB_PREFIX?.trim()) {
    throw new Error(
      "memory fixtures require MEMORY_BLOB_PREFIX so they cannot land in real chat memory. Set it (e.g. MEMORY_BLOB_PREFIX=eval) before running memory evals.",
    );
  }
};

/**
 * A throwaway DM JID. Not `@g.us`, which is the whole point — see the module
 * comment. Unique per call because evals run eight at a time against one store.
 */
export const dmFixtureJid = (): string => `eval-${randomUUID().replaceAll("-", "")}@s.whatsapp.net`;

/**
 * Seed a DM's memory and audit trail, run `fn`, then delete both.
 *
 * Cleanup is in a `finally` for the reason `fixtures.ts` documents: eve has no
 * teardown hook and a failed `t.require` aborts the eval body where it stands,
 * so anything written outside a `finally` leaks.
 */
export const withDmMemoryFixture = async <T>(
  fixture: { memory: GroupMemory; writes?: readonly MemoryWrite[] },
  fn: (jid: string) => Promise<T>,
): Promise<T> => {
  requirePrefix();
  const jid = dmFixtureJid();
  try {
    await mutateJson<GroupMemory>(memoryKey(jid), (current) => ({
      ...current,
      ...fixture.memory,
    }));
    if (fixture.writes?.length) {
      await appendMemoryWrites(jid, fixture.writes);
    }
    return await fn(jid);
  } finally {
    await clearMemoryFixture(jid);
  }
};
