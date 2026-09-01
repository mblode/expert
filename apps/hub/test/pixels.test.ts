import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PixelRegistry, withPixelToken } from "../src/service/pixels.ts";

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

  it("accepts a start-window fork token file that was never minted", () => {
    const dir = mkdtempSync(join(tmpdir(), "pix-"));
    writeFileSync(join(dir, "3"), "deadbeefcafebabe\n", { mode: 0o600 });
    const pixels = new PixelRegistry({ tokenDir: dir });
    const g = pixels.lookup("deadbeefcafebabe");
    expect(g?.display).toBe(3);
    expect(g?.token).toBe("deadbeefcafebabe");
    expect(pixels.lookup("nope")).toBeUndefined();
  });

  it("still accepts a minted fork token after the in-memory grant expires", () => {
    const dir = mkdtempSync(join(tmpdir(), "pix-"));
    const pixels = new PixelRegistry({ ttlMs: 1_000, tokenDir: dir });
    const t0 = 1_000_000;
    const g = pixels.mint(2, t0);
    expect(pixels.lookup(g.token, t0 + 10)).toEqual(g);
    const after = pixels.lookup(g.token, t0 + 1_001);
    expect(after?.token).toBe(g.token);
    expect(after?.display).toBe(2);
  });

  it("rejects an empty token file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pix-"));
    writeFileSync(join(dir, "2"), "\n", { mode: 0o600 });
    const pixels = new PixelRegistry({ tokenDir: dir });
    expect(pixels.lookup("")).toBeUndefined();
    expect(pixels.lookup("anything")).toBeUndefined();
  });
});
