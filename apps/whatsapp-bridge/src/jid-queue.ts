/**
 * Per-JID serialization for the WhatsApp bridge.
 *
 * `messages.upsert` events fire concurrently: two messages for the same chat
 * arriving as separate events run their handlers at the same time. Unserialized
 * they interleave, two replies composed against the same context tail, two
 * presence updates fighting over the "typing…" indicator, and two store writes
 * landing out of order, so the transcript no longer matches what was said. This
 * queue chains tasks per chat JID so same-chat work runs strictly in order,
 * while different chats still run in parallel.
 *
 * It was originally added for a sharper failure: the owner's DMs went to a
 * second-brain agent with a persistent-session cursor, and two concurrent
 * handlers reading the same `streamIndex` left it permanently behind, so every
 * later reply was a stale prior turn. That route is gone; the ordering
 * guarantee is still worth having.
 */

export interface JidQueue {
  /** Run `task` after any pending work for `key`; different keys run concurrently. */
  run: <T>(key: string, task: () => Promise<T>) => Promise<T>;
  /** Number of chats with live chains (for observability/tests). */
  get size(): number;
}

export const createJidQueue = (): JidQueue => {
  const tails = new Map<string, Promise<unknown>>();
  return {
    run(key, task) {
      const prev = tails.get(key) ?? Promise.resolve();
      // The caller sees the real result (including rejection): run after prev,
      // whose own failure was already surfaced to its caller so we ignore it.
      const result = (async () => {
        try {
          await prev;
        } catch {
          // predecessor failure belongs to its own caller
        }
        return await task();
      })();
      tails.set(key, result);
      // Drop the entry once this task settles, unless a newer one replaced it.
      // Swallow the rejection here (it's surfaced to the caller via `result`) so
      // one failure can't wedge the key.
      void (async () => {
        try {
          await result;
        } catch {
          // surfaced via `result` to the caller
        }
        if (tails.get(key) === result) {
          tails.delete(key);
        }
      })();
      return result;
    },
    get size() {
      return tails.size;
    },
  };
};
