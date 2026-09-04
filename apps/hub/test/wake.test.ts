import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { awakeUntil, botWaker, keepAwake, watchWake } from "../src/host/wake.ts";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) {
    rmSync(temps.pop()!, { force: true, recursive: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wake-"));
  temps.push(dir);
  return dir;
}

/**
 * The hub decides who is awake, the supervisor owns the processes, and one
 * small file per Bot is everything they say to each other. These are the
 * three rules that makes safe: the later time wins, a broken file means
 * asleep rather than an exception, and nothing is ever started that the hub
 * did not ask for.
 */
describe("wake markers", () => {
  it("holds a Bot awake until the time in its file", () => {
    const dir = join(tempDir(), "wake");
    expect(awakeUntil(dir, "qa")).toBe(0);
    keepAwake(dir, "qa", 5000);
    expect(awakeUntil(dir, "qa")).toBe(5000);
    expect(readFileSync(join(dir, "qa"), "utf-8").trim()).toBe(new Date(5000).toISOString());
  });

  it("never shortens a window someone else opened", () => {
    const dir = tempDir();
    keepAwake(dir, "qa", 9000);
    keepAwake(dir, "qa", 5000);
    expect(awakeUntil(dir, "qa")).toBe(9000);
  });

  it("reads a file that is not a time as asleep", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "qa"), "soon");
    expect(awakeUntil(dir, "qa")).toBe(0);
  });
});

describe("the supervisor follows the markers", () => {
  it("starts a Bot whose marker is in the future and stops one whose is not", () => {
    const dir = tempDir();
    const started: string[] = [];
    const stopped: string[] = [];
    let now = 1000;
    keepAwake(dir, "qa", 5000);
    const stop = watchWake({
      botIds: ["qa", "seo"],
      dir,
      now: () => now,
      pollMs: 60_000,
      sup: {
        ensure: (id) => started.push(id),
        stop: async (id) => {
          stopped.push(id);
        },
      },
    });
    // The first tick is immediate: a boot must not wait a poll to honour a
    // marker that was already there.
    expect(started).toEqual(["eve-qa"]);
    expect(stopped).toEqual(["eve-seo"]);
    stop();

    now = 6000;
    const later: string[] = [];
    const laterStops: string[] = [];
    watchWake({
      botIds: ["qa"],
      dir,
      now: () => now,
      pollMs: 60_000,
      sup: {
        ensure: (id) => later.push(id),
        stop: async (id) => {
          laterStops.push(id);
        },
      },
    })();
    expect(later).toEqual([]);
    expect(laterStops).toEqual(["eve-qa"]);
  });
});

describe("waking a Bot from the hub", () => {
  it("writes the marker and waits for that Bot's Eve to answer", async () => {
    const dir = tempDir();
    let now = 1000;
    let probes = 0;
    const wake = botWaker({
      awakeMs: 60_000,
      dir,
      eveUrl: (_botId, display) => `http://127.0.0.1:${2000 + display - 1}`,
      fetchImpl: (async (url: string) => {
        probes += 1;
        expect(url).toBe("http://127.0.0.1:2005/eve/v1/health");
        return { ok: probes >= 3 } as Response;
      }) as unknown as typeof fetch,
      now: () => now,
      sleepImpl: async () => {
        now += 150;
      },
    });

    await wake("qa", 6);
    expect(probes).toBe(3);
    expect(awakeUntil(dir, "qa")).toBe(61_000);
  });

  it("does not wait on a Bot that is already awake", async () => {
    const dir = tempDir();
    let probes = 0;
    keepAwake(dir, "qa", Date.now() + 60_000);
    const wake = botWaker({
      dir,
      eveUrl: () => "http://127.0.0.1:2005",
      fetchImpl: (async () => {
        probes += 1;
        return { ok: true } as Response;
      }) as unknown as typeof fetch,
    });
    await wake("qa", 6);
    expect(probes).toBe(0);
  });

  it("gives up after the deadline rather than holding the request open", async () => {
    const dir = tempDir();
    let now = 0;
    const wake = botWaker({
      dir,
      eveUrl: () => "http://127.0.0.1:2005",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      now: () => now,
      sleepImpl: async () => {
        now += 150;
      },
      waitMs: 600,
    });
    await wake("qa", 6);
    expect(now).toBeGreaterThanOrEqual(600);
  });

  it("says nothing and moves on when there is nowhere to write", async () => {
    // A file where the directory should be: ENOTDIR, the shape of a run dir
    // the hub cannot create because it is not root.
    const notADir = join(tempDir(), "wake");
    writeFileSync(notADir, "");
    const wake = botWaker({
      dir: join(notADir, "inside"),
      eveUrl: () => "http://127.0.0.1:2005",
      fetchImpl: (async () => ({ ok: true }) as Response) as unknown as typeof fetch,
    });
    await expect(wake("qa", 6)).resolves.toBeUndefined();
  });
});

describe("a marker is a request, not a guarantee", () => {
  it("keeps only the most recently asked-for Bots awake", () => {
    const dir = tempDir();
    const started: string[] = [];
    const stopped: string[] = [];
    keepAwake(dir, "qa", 9000);
    keepAwake(dir, "seo", 8000);
    keepAwake(dir, "pm", 7000);
    watchWake({
      botIds: ["qa", "seo", "pm"],
      dir,
      maxAwake: 2,
      now: () => 1000,
      pollMs: 60_000,
      sup: {
        ensure: (id) => started.push(id),
        stop: async (id) => {
          stopped.push(id);
        },
      },
    })();
    // Eight Bots asking at once is 1.8 GB of Eve on a 2 GB box, so the oldest
    // request loses rather than the machine.
    expect(started).toEqual(["eve-qa", "eve-seo"]);
    expect(stopped).toEqual(["eve-pm"]);
  });

  it("survives a supervisor that throws, because this runs inside PID 1", () => {
    const dir = tempDir();
    keepAwake(dir, "qa", 9000);
    expect(() =>
      watchWake({
        botIds: ["qa"],
        dir,
        now: () => 1000,
        pollMs: 60_000,
        sup: {
          ensure: () => {
            throw new Error("EMFILE");
          },
          stop: async () => undefined,
        },
      })(),
    ).not.toThrow();
  });
});
