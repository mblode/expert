import { describe, expect, it } from "vitest";
import { PIXEL_REFRESH_MS, PixelRegistry, withPixelToken } from "../src/service/pixels.ts";

describe("PixelRegistry", () => {
  it("maps Grok noVNC ports: :1 → 6080, :2 → 6081", () => {
    expect(PixelRegistry.novncPort(1)).toBe(6080);
    expect(PixelRegistry.novncPort(2)).toBe(6081);
    expect(PixelRegistry.rfbPort(1)).toBe(5901);
    expect(PixelRegistry.rfbPort(2)).toBe(5902);
  });

  it("mints a grant that expires", () => {
    const pixels = new PixelRegistry({ ttlMs: 1_000 });
    const t0 = 1_000_000;
    const g = pixels.mint(1, t0);
    expect(pixels.lookup(g.token, t0 + 10)).toEqual(g);
    expect(pixels.lookup(g.token, t0 + 1_001)).toBeUndefined();
  });

  it("stamps a pixel token into vnc_url, not a caller-supplied seat token", () => {
    const pixels = new PixelRegistry({ ttlMs: 60_000 });
    const g = pixels.mint(2, 5_000);
    const url = withPixelToken("http://127.0.0.1/vnc/index.html", g);
    expect(url).toContain(`token=${g.token}`);
    expect(url).toContain("display=2");
    expect(url).toContain("view_only=1");
    expect(url).toContain("expires=");
  });

  it("reuses a still-valid grant for the same display", () => {
    const pixels = new PixelRegistry({ ttlMs: 15 * 60 * 1000 });
    const t0 = 1_000_000;
    const a = pixels.grantFor(1, t0);
    const b = pixels.grantFor(1, t0 + 2_000);
    expect(b.token).toBe(a.token);
    expect(b.expires).toBe(a.expires);
  });

  it("mints a new grant when the current one is within PIXEL_REFRESH_MS of expiry", () => {
    const pixels = new PixelRegistry({ ttlMs: 15 * 60 * 1000 });
    const t0 = 1_000_000;
    const a = pixels.grantFor(1, t0);
    const b = pixels.grantFor(1, a.expires - PIXEL_REFRESH_MS);
    expect(b.token).not.toBe(a.token);
    expect(pixels.lookup(a.token, a.expires - PIXEL_REFRESH_MS)).toEqual(a);
  });

  it("keeps grants per display", () => {
    const pixels = new PixelRegistry({ ttlMs: 15 * 60 * 1000 });
    const a = pixels.grantFor(1, 0);
    const b = pixels.grantFor(2, 0);
    expect(a.token).not.toBe(b.token);
    expect(a.display).toBe(1);
    expect(b.display).toBe(2);
  });
});
