import { timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Registration {
  tenant: string;
  id: string;
  until: number;
  at?: number;
}
/** Active work leases only. Registered hosts come from CLOCK_TARGETS, never the request. */
export class Registrations {
  private rows: Registration[];
  constructor(
    private readonly path: string,
    private readonly secrets: Record<string, string>,
  ) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (
        !Array.isArray(raw) ||
        raw.some(
          (r) =>
            !r ||
            typeof r.tenant !== "string" ||
            typeof r.id !== "string" ||
            !Number.isFinite(r.until) ||
            (r.at !== undefined && !Number.isFinite(r.at)),
        )
      )
        throw new Error("invalid clock registration store");
      this.rows = raw;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.rows = [];
    }
  }
  put(body: unknown, secret: string, targets: readonly string[], now = Date.now()): void {
    if (!body || typeof body !== "object") throw new Error("invalid registration");
    const value = body as Record<string, unknown>;
    const { tenant, id, until, at } = value;
    if (
      typeof tenant !== "string" ||
      !targets.includes(tenant) ||
      typeof id !== "string" ||
      !/^[a-f0-9]{64}$/.test(id) ||
      typeof until !== "number" ||
      !Number.isFinite(until) ||
      until > now + 40 * 60_000 ||
      (at !== undefined &&
        (typeof at !== "number" ||
          !Number.isFinite(at) ||
          at < 0 ||
          at > now + 367 * 24 * 60 * 60_000))
    )
      throw new Error("invalid registration");
    const expected = this.secrets[tenant];
    if (
      !expected ||
      expected.length < 32 ||
      Buffer.byteLength(secret) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))
    )
      throw new Error("registration refused");
    const rows = this.rows.filter(
      (r) => (r.at !== undefined || r.until > now) && !(r.tenant === tenant && r.id === id),
    );
    if (at !== undefined || until > now)
      rows.push({ tenant, id, until, ...(typeof at === "number" ? { at } : {}) });
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600 });
    renameSync(temporary, this.path);
    this.rows = rows;
  }
  active(tenant: string, now = Date.now()): boolean {
    return this.rows.some(
      (r) => r.tenant === tenant && (r.at === undefined ? r.until > now : r.at <= now),
    );
  }
}
