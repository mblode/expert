/**
 * One computer, as the clock sees it: a public URL and a window of time the
 * Machine behind it has to be awake for.
 *
 * Waking is an ordinary GET to `/healthz` on the tenant's public hostname.
 * That is the whole mechanism, and it is deliberately the least the clock can
 * hold: Fly Proxy starts a stopped or suspended Machine to serve a request,
 * `/healthz` is the one public unauthenticated route the hub has, and so this
 * app carries no seat token, no setup code and no way to make the box do
 * anything except exist. A stolen clock wakes computers up.
 *
 * It must be the public hostname rather than `<app>.internal`: 6PN skips Fly
 * Proxy, so a request over the private network reaches a suspended Machine as
 * a connection error instead of waking it. Same reason the WhatsApp bridge
 * holds a public `hub_url` (`docs/plans/gateway.md`).
 *
 * Holding is the other half. One request wakes the Machine, but nothing keeps
 * it up: a routine turn makes no inbound traffic of its own, so Fly Proxy
 * would suspend the guest underneath a Bot that is still working. So the
 * clock keeps pinging while the box says it is busy, and the box is the one
 * that decides when that is over (`busy` in the hub's `/healthz`, written
 * from the wake markers). `maxHoldMs` is the backstop for a marker that never
 * clears: a stuck box costs a bounded amount of money rather than a month of
 * it.
 */
interface TenantOptions {
  /** For logs and the clock's own health page. */
  name: string;
  /** Public base URL, e.g. `https://mblode-computer.fly.dev`. */
  url: string;
  /** How long one wake holds the Machine up before `busy` has to justify it. */
  holdMs: number;
  /** How much longer a box that answers `busy` is held. */
  busyGraceMs: number;
  /** The longest one wake may hold the Machine, however busy it claims to be. */
  maxHoldMs: number;
  /** How long to wait for a ping. A resume from suspend is served slowly, once. */
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

interface TenantStatus {
  name: string;
  url: string;
  /** ISO, or "" while nothing is being held up. */
  held_until: string;
  last_ping: string;
  /** The last ping's outcome, in the words a person reading logs wants. */
  last_result: string;
  /** What the box said about itself on that ping. */
  box_busy: boolean;
  wakes: number;
  failures: number;
}

export class Tenant {
  readonly name: string;
  readonly url: string;
  private readonly opts: TenantOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private until = 0;
  private deadline = 0;
  /** A resume can outlast a tick; one ping at a time per tenant. */
  private inflight = false;
  private lastPing = 0;
  private lastResult = "";
  private boxBusy = false;
  private wakes = 0;
  private failures = 0;

  constructor(opts: TenantOptions) {
    this.opts = opts;
    this.name = opts.name;
    this.url = opts.url.replace(/\/$/u, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /** Is this tenant inside a window the clock is holding open? */
  holding(at = this.now()): boolean {
    return at < this.until;
  }

  /**
   * Ask for the Machine to be awake from now. Extends an open window rather
   * than restarting it, so a burst of routines in one minute is one hold and
   * one deadline.
   */
  wake(reason: string): void {
    const at = this.now();
    if (at >= this.until) {
      this.deadline = at + this.opts.maxHoldMs;
      this.wakes += 1;
      this.opts.log?.(`${this.name}: waking for ${reason}`);
    }
    this.until = Math.min(Math.max(this.until, at + this.opts.holdMs), this.deadline);
  }

  /**
   * One tick of the hold: ping while the window is open, and let the box
   * extend it. Resolves when the ping settles, and never rejects, because the
   * caller is a timer.
   */
  async poll(): Promise<void> {
    if (this.inflight || !this.holding()) {
      return;
    }
    this.inflight = true;
    try {
      const res = await this.fetchImpl(`${this.url}/healthz`, {
        headers: { "user-agent": "computer-clock" },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
      // The body is the hub's, but a proxy error page arrives here too, so
      // nothing below may assume it parsed.
      const body = (await res.json().catch(() => ({}))) as { busy?: unknown; ok?: unknown };
      this.boxBusy = body.busy === true;
      this.lastResult = `${res.status}${res.ok ? "" : " (not ok)"} busy=${this.boxBusy} box_ok=${body.ok === true}`;
      if (res.ok) {
        this.failures = 0;
        if (this.boxBusy) {
          this.until = Math.min(this.now() + this.opts.busyGraceMs, this.deadline);
        }
      } else {
        this.failures += 1;
      }
    } catch (error) {
      // A wake that fails is retried by the next tick, which is still inside
      // the hold window: the lead time exists so that a slow resume, a
      // timeout, or one bad deploy does not cost the routine.
      this.failures += 1;
      this.lastResult = `failed: ${(error as Error).message}`;
      this.opts.log?.(`${this.name}: ping failed (${(error as Error).message})`);
    } finally {
      this.lastPing = this.now();
      this.inflight = false;
    }
  }

  status(): TenantStatus {
    return {
      box_busy: this.boxBusy,
      failures: this.failures,
      held_until: this.holding() ? new Date(this.until).toISOString() : "",
      last_ping: this.lastPing === 0 ? "" : new Date(this.lastPing).toISOString(),
      last_result: this.lastResult,
      name: this.name,
      url: this.url,
      wakes: this.wakes,
    };
  }
}

/**
 * Tenants from `CLOCK_TARGETS`: `name=url` pairs, or bare URLs named after
 * their host, comma or whitespace separated.
 *
 * Anything that is not an http(s) URL is dropped with a warning rather than
 * failing the boot: a clock that is up and waking three of four tenants beats
 * one that refused to start over a typo in the fourth, and `/healthz` lists
 * what it did parse.
 */
export function parseTargets(
  raw: string | undefined,
  warn: (line: string) => void = () => undefined,
): { name: string; url: string }[] {
  const out: { name: string; url: string }[] = [];
  for (const entry of (raw ?? "").split(/[\s,]+/u).filter(Boolean)) {
    const eq = entry.indexOf("=");
    // Split on the first `=` only: it is the separator, and a URL may carry
    // one in a query string.
    const name = eq === -1 ? "" : entry.slice(0, eq);
    const url = eq === -1 ? entry : entry.slice(eq + 1);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      warn(`clock: ignoring target "${entry}": not a URL`);
      continue;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      warn(`clock: ignoring target "${entry}": not http(s)`);
      continue;
    }
    out.push({ name: name || parsed.hostname, url });
  }
  return out;
}
