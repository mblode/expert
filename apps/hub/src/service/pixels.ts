import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { MAX_DISPLAYS } from "@computer/shared";

/** Default lifetime for a pixel (noVNC) token. Seat tokens stay long-lived. */
export const DEFAULT_PIXEL_TTL_MS = 15 * 60 * 1000;

export type PixelGrant = {
  token: string;
  display: number;
  expires: number;
};

/**
 * Short-lived VNC / noVNC tokens. Pairing still uses the durable seat
 * token for Seat RPCs; Status/Pair stamp a pixel token into `vnc_url`.
 * The seat token remains accepted on `/vnc` so an old iOS pair URL works.
 */
export class PixelRegistry {
  private readonly grants = new Map<string, PixelGrant>();
  private readonly ttlMs: number;
  private readonly tokenDir: string | undefined;

  constructor(opts: { ttlMs?: number; tokenDir?: string } = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_PIXEL_TTL_MS;
    this.tokenDir = opts.tokenDir;
  }

  mint(display: number, now = Date.now()): PixelGrant {
    this.sweep(now);
    const token = randomBytes(24).toString("base64url");
    const grant: PixelGrant = { token, display, expires: now + this.ttlMs };
    this.grants.set(token, grant);
    this.writeForkFile(display, token);
    return grant;
  }

  /**
   * Valid pixel token, or undefined. Expired in-memory grants are dropped.
   * A fork-port token file (`$tokenDir/{2-8}`, also `{1}` if present) is
   * accepted until `stop-window` deletes it — start-window writes an openssl
   * hex token that is never minted into memory.
   */
  lookup(token: string | undefined, now = Date.now()): PixelGrant | undefined {
    if (!token) return undefined;
    const g = this.grants.get(token);
    if (g) {
      if (g.expires > now) return g;
      this.grants.delete(token);
    }
    return this.lookupFile(token);
  }

  sweep(now = Date.now()): void {
    for (const [k, g] of this.grants) {
      if (g.expires <= now) this.grants.delete(k);
    }
  }

  /** Grok maps display N to noVNC 6080+(N-1). Primary :1 → 6080. */
  static novncPort(display: number, base = 6080): number {
    return base + display - 1;
  }

  /** x11vnc RFB: window N listens on 5900+N (primary :1 → 5901). */
  static rfbPort(display: number, base = 5900): number {
    return base + display;
  }

  private writeForkFile(display: number, token: string): void {
    if (!this.tokenDir || display < 2) return;
    mkdirSync(this.tokenDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.tokenDir, String(display)), `${token}\n`, { mode: 0o600 });
  }

  /**
   * Compare against every display file. No early exit on match so a wrong
   * token does not leak which file existed via timing.
   */
  private lookupFile(token: string): PixelGrant | undefined {
    if (!this.tokenDir) return undefined;
    let found: PixelGrant | undefined;
    for (let display = 1; display <= MAX_DISPLAYS; display++) {
      const raw = readTokenFile(this.tokenDir, display);
      if (raw !== undefined && tokensEqual(raw, token)) {
        found = { token, display, expires: Number.MAX_SAFE_INTEGER };
      }
    }
    return found;
  }
}

function readTokenFile(dir: string, display: number): string | undefined {
  try {
    const raw = readFileSync(join(dir, String(display)), "utf8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function withPixelToken(base: string, grant: PixelGrant): string {
  try {
    const u = new URL(base);
    u.searchParams.set("view_only", "1");
    u.searchParams.set("token", grant.token);
    u.searchParams.set("expires", String(grant.expires));
    if (grant.display > 1) u.searchParams.set("display", String(grant.display));
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    const extra = grant.display > 1 ? `&display=${grant.display}` : "";
    return `${base}${sep}view_only=1&token=${encodeURIComponent(grant.token)}&expires=${grant.expires}${extra}`;
  }
}
