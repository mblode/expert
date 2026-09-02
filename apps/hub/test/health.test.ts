import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readHealth } from "../src/service/health.ts";

describe("healthz reads the supervisor", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });
  const file = (body: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-health-"));
    dirs.push(dir);
    const path = join(dir, "status.json");
    writeFileSync(path, body);
    return path;
  };

  it("is the hub alone without a status file", () => {
    expect(readHealth(undefined)).toEqual({ hub: true, ok: true });
  });

  it("mirrors the supervisor's ok and children", () => {
    const now = Date.parse("2026-09-02T10:00:00Z");
    const path = file(
      JSON.stringify({
        at: "2026-09-02T09:59:30Z",
        children: [
          { healthy: true, id: "eve-main", restarts: 0, state: "up" },
          { healthy: null, id: "desk", restarts: 0, state: "done" },
        ],
        ok: true,
      }),
    );
    const h = readHealth(path, now);
    expect(h.ok).toBe(true);
    expect(h.supervisor?.stale).toBe(false);
    expect(h.supervisor?.children.map((c) => c.id)).toEqual(["eve-main", "desk"]);
  });

  it("a stale or unreadable status file is not ok, but the hub still answers", () => {
    const now = Date.parse("2026-09-02T10:00:00Z");
    const stale = readHealth(
      file(JSON.stringify({ at: "2026-09-02T09:00:00Z", children: [], ok: true })),
      now,
    );
    expect(stale).toMatchObject({ hub: true, ok: false, supervisor: { stale: true } });
    const gone = readHealth(join(tmpdir(), "no-such-status.json"), now);
    expect(gone).toMatchObject({ hub: true, ok: false });
  });
});
