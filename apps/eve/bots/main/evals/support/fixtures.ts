import { randomUUID } from "node:crypto";

import { del } from "@vercel/blob";

import type { GroupMemory, MemoryWrite } from "../../../../lib/vibey/memory-store.ts";
import {
  auditKey,
  blobConfigured,
  episodesKey,
  memoryKey,
  mutateJson,
  readJson,
} from "../../../../lib/vibey/memory-store.ts";

/**
 * Seed and tear down a group-memory fixture for one eval.
 *
 * Three constraints shape this, all of them learned the hard way:
 *
 *   1. **Cleanup must be in a `finally`.** eve has no setup/teardown hooks, and
 *      a failed `t.require` aborts the eval body on the spot — so anything after
 *      the assertions never runs, and the fixture leaks. Every path out of
 *      `withMemoryFixture` goes through its `finally`.
 *   2. **A unique JID per call.** Evals run at a default concurrency of 8
 *      against one shared blob store; two evals sharing a JID would race, and
 *      whichever finished first would delete the other's fixture mid-run.
 *   3. **The store is real.** `BLOB_READ_WRITE_TOKEN` comes from `.env.local`,
 *      so these writes hit the same Vercel Blob store production uses. Set
 *      `MEMORY_BLOB_PREFIX` before running so they land in their own namespace
 *      as well as under their own JID.
 */

/**
 * A throwaway group JID that no real chat can collide with. The `@g.us` suffix
 * matters: some paths only treat a JID as a group when it ends that way.
 */
export const fixtureJid = (): string => `eval-${randomUUID().replaceAll("-", "")}@g.us`;

/** Delete every blob a fixture JID could have produced. Best-effort. */
export const clearMemoryFixture = async (jid: string): Promise<void> => {
  if (!blobConfigured()) {
    return;
  }
  try {
    // Memory itself plus the two things a turn can write as a side effect: the
    // audit trail (any save or revert) and episodes (a digest run).
    await del([memoryKey(jid), auditKey(jid), episodesKey(jid)]);
  } catch {
    // Teardown must never turn a passing eval into a failing one, and a delete
    // of a blob that was never created is the common case.
  }
};

/**
 * Read a fixture's memory bypassing the CDN cache.
 *
 * `readJson` defaults to `useCache: true` because it fronts every reply, and
 * Blob's CDN can serve a just-written value stale for up to a minute — long
 * enough that an eval asserting on what a `save-memory` turn wrote would read
 * the pre-write value. Assert through this, not `readGroupMemory`. (A unique
 * JID per run also stops a cached *negative* entry from an earlier run
 * shadowing a fresh fixture, which is the other half of the same problem.)
 */
export const readFixtureMemory = async (jid: string): Promise<GroupMemory | null> => {
  const read = await readJson<GroupMemory>(memoryKey(jid), { fresh: true });
  return read?.value ?? null;
};

/** The audit trail for a fixture JID, uncached. See {@link readFixtureMemory}. */
export const readFixtureWrites = async (jid: string): Promise<MemoryWrite[]> => {
  const read = await readJson<MemoryWrite[]>(auditKey(jid), { fresh: true });
  return read?.value ?? [];
};

/**
 * Write `memory` under a fresh JID, run `fn` against it, and delete it again.
 *
 * ```ts
 * await withMemoryFixture({ lore: "Fraser once shipped on a Sunday." }, (jid) =>
 *   t.send({
 *     message: "what do you know about Fraser?",
 *     headers: { "x-eval-chat-jid": jid },
 *   })
 * );
 * ```
 *
 * Returns whatever `fn` returns, and rethrows whatever it throws — after
 * cleanup either way.
 */
export const withMemoryFixture = async <T>(
  memory: GroupMemory,
  fn: (jid: string) => Promise<T>,
): Promise<T> => {
  // Refuse to run without a namespace. BLOB_READ_WRITE_TOKEN points at the live
  // store, so an unprefixed fixture writes into real group memory — and teardown
  // is best-effort (it swallows delete failures so a cleanup error can't fail a
  // passing eval), which means a bad run leaves that pollution behind.
  //
  // The guard lives here rather than in the auth seam on purpose: arming a
  // session with a group JID is an auth decision, writing a blob is a storage
  // one, and coupling them would break any eval that wants a JID without a
  // fixture. This is the storage side, so this is where the storage guard goes.
  if (!process.env.MEMORY_BLOB_PREFIX?.trim()) {
    throw new Error(
      "withMemoryFixture requires MEMORY_BLOB_PREFIX so fixtures cannot land in real group memory. Set it (e.g. MEMORY_BLOB_PREFIX=eval) before running memory evals.",
    );
  }
  const jid = fixtureJid();
  try {
    // One read-modify-write for the whole fixture. Writing category by category
    // would fire N concurrent RMWs at the same blob and burn `mutateJson`'s
    // retry budget for no reason.
    await mutateJson<GroupMemory>(memoryKey(jid), (current) => ({
      ...current,
      ...memory,
    }));
    return await fn(jid);
  } finally {
    await clearMemoryFixture(jid);
  }
};
