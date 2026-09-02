/**
 * Insertion-ordered cache with a hard cap. Used for `request_id` idempotency:
 * a retry within the window gets the first response, and a hub that runs for
 * weeks does not keep every screenshot it ever returned.
 */
export class BoundedCache<V> {
  private readonly map = new Map<string, V>();

  constructor(private readonly max = 256) {}

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
