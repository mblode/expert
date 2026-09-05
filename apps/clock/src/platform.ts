import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

interface Target {
  app: string;
  clock_secret: string;
}
/** Only the authenticated control plane may introduce a hostname or wake credential. */
export class PlatformTargets {
  private busy = false;
  private rows: Target[] = [];
  constructor(
    private readonly path: string,
    private readonly url: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    try {
      this.rows = this.parse(JSON.parse(readFileSync(path, "utf-8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private parse(value: unknown): Target[] {
    if (
      !Array.isArray(value) ||
      value.some(
        (row) =>
          !row ||
          typeof row.app !== "string" ||
          !/^expert-[a-f0-9]{32}$/u.test(row.app) ||
          typeof row.clock_secret !== "string" ||
          row.clock_secret.length < 32,
      )
    )
      throw new Error("Invalid platform targets");
    return value;
  }
  current() {
    return this.rows;
  }
  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const response = await this.fetchImpl(new URL("/api/internal/phone-provision", this.url), {
        method: "POST",
        redirect: "error",
        headers: { "x-provision-secret": this.secret },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("Platform unavailable");
      const body = (await response.json()) as { targets?: unknown };
      const rows = this.parse(body.targets);
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      writeFileSync(`${this.path}.tmp`, JSON.stringify(rows), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
      this.rows = rows;
    } catch {
      console.warn("clock platform refresh deferred");
    } finally {
      this.busy = false;
    }
  }
}
