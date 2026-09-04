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

  /**
   * `busy` is what the clock outside the Machine reads to decide whether to
   * keep holding it awake (`apps/clock`), so the two ways it can lie both
   * cost a routine: a throw here would be a 500 and no answer at all, and a
   * field that is always there would tell a clock to hold up a dev box.
   */
  it("reports whether a Bot is at work, and survives a probe that throws", () => {
    expect(readHealth(undefined, Date.now(), () => true)).toMatchObject({ busy: true, ok: true });
    expect(readHealth(undefined, Date.now(), () => false)).toMatchObject({ busy: false });
    expect(readHealth(undefined)).not.toHaveProperty("busy");
    expect(
      readHealth(undefined, Date.now(), () => {
        throw new Error("no wake directory");
      }),
    ).toEqual({ hub: true, ok: true });
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

  it("an unparseable timestamp is stale, not fresh", () => {
    // `NaN > STALE_MS` is false, so comparing without a finite check read a
    // garbage `at` as "written just now" and a stopped supervisor kept
    // reporting ok on the route Fly health-checks the guest with.
    const h = readHealth(
      file(JSON.stringify({ at: "not-a-date", children: [], ok: true })),
      Date.parse("2026-09-02T10:00:00Z"),
    );
    expect(h.ok).toBe(false);
    expect(h.supervisor?.stale).toBe(true);
  });

  it("a status file that is valid JSON but not a record answers, it does not throw", () => {
    // `JSON.parse` accepts `null` and a bare number; reading `.at` off either
    // throws, and a throw here is a 500 from /healthz, which fails the Fly
    // health check and restarts the Machine. Every bad file is one answer.
    const now = Date.parse("2026-09-02T10:00:00Z");
    for (const body of ["null", "42", '"up"', "[]"]) {
      expect(readHealth(file(body), now)).toMatchObject({
        hub: true,
        ok: false,
        supervisor: { stale: true },
      });
    }
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
