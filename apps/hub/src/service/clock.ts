import { ComputerError } from "@computer/shared";

/** The clock holds only a wake lease, never a seat or the work itself. */
export class ClockClient {
  constructor(
    private readonly url: string,
    private readonly tenant: string,
    private readonly secret: string,
  ) {}
  hold(id: string, until = Date.now() + 35 * 60_000): Promise<void> {
    return this.register({ id, until });
  }
  /** A due check remains registered until the hub advances or cancels it. */
  checkAt(id: string, at: number): Promise<void> {
    return this.register({ id, at, until: 0 });
  }
  private async register(input: { id: string; until: number; at?: number }): Promise<void> {
    try {
      const response = await fetch(`${this.url.replace(/\/$/, "")}/registrations`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-clock-secret": this.secret },
        body: JSON.stringify({ tenant: this.tenant, ...input }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!response.ok) throw new Error("registration refused");
    } catch {
      throw new ComputerError(
        "DAEMON_DOWN",
        "background work cannot start because the wake clock is unavailable",
      );
    }
  }
}
