import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

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
   * Valid pixel token, or undefined. Expired grants are dropped.
   * A fork-port token file is also accepted (Grok 6081 + token file).
   */
  lookup(token: string | undefined, now = Date.now()): PixelGrant | undefined {
    if (!token) return undefined;
    const g = this.grants.get(token);
    if (g) {
      if (g.expires <= now) {
        this.grants.delete(token);
        return undefined;
      }
      return g;
    }
    return undefined;
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
