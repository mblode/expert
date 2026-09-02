import { ComputerError } from "@computer/shared";

type Entry<T> = { hash: string; promise: Promise<T> };

/**
 * `request_id` idempotency for the model's tools.
 *
 * `run(key, hash, fn)` executes `fn` once per key. A later call with the same
 * key and hash gets the first call's promise, including while it is still
 * running, which is what stops a retry over a flaky transport from
 * double-clicking. A different hash under the same key is `CONFLICT`. A run
 * that rejects is forgotten, so a batch that never started (`SEAT_HELD`,
 * `DAEMON_DOWN`) can be retried under its id.
 *
 * Bounded and insertion-ordered: a hub that runs for weeks must not keep
 * every screenshot it ever returned.
 */
export class RequestCache<T> {
  private readonly map = new Map<string, Entry<T>>();

  constructor(private readonly max = 256) {}

  run(key: string, hash: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit) {
      if (hit.hash !== hash) {
        throw new ComputerError("CONFLICT", "request_id reused with a different body");
      }
      return hit.promise;
    }
    const promise = fn().catch((error: unknown) => {
      this.map.delete(key);
      throw error;
    });
    this.map.set(key, { hash, promise });
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value!);
    }
    return promise;
  }
}
