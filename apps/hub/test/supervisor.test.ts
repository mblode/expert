import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "../src/host/supervisor.ts";

const node = (script: string) => ({ args: ["-e", script], cmd: process.execPath });

const until = async (pred: () => boolean, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) {
      throw new Error("timed out");
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

/** A health endpoint the test flips between ok and failing. */
function healthServer(): Promise<{
  url: string;
  set: (ok: boolean) => void;
  close: () => Promise<void>;
}> {
  let ok = true;
  const server: Server = createServer((_req, res) => {
    res.writeHead(ok ? 200 : 503);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({
        close: () => new Promise((r) => server.close(() => r())),
        set: (v) => {
          ok = v;
        },
        url: `http://127.0.0.1:${addr.port}/health`,
      });
    });
  });
}

describe("supervisor", () => {
  const dirs: string[] = [];
  const sups: Supervisor[] = [];
  afterEach(async () => {
    await Promise.all(sups.splice(0).map((s) => s.stopAll(500)));
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });
  const tmp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-sup-"));
    dirs.push(dir);
    return dir;
  };

  it("restarts a crashing child with growing backoff and reports it", async () => {
    const dir = tmp();
    const events: string[] = [];
    const sup = new Supervisor({
      backoff: { initialMs: 20, maxMs: 80, stableMs: 60_000 },
      onEvent: (l) => events.push(l),
      statusFile: join(dir, "status.json"),
    });
    sups.push(sup);
    sup.start({ ...node("process.exit(2)"), id: "crashy", log: join(dir, "logs", "crashy.log") });
    await until(() => sup.status().children[0]!.restarts >= 3);
    const child = sup.status().children[0]!;
    expect(child.id).toBe("crashy");
    expect(child.last_exit?.code).toBe(2);
    expect(["restarting", "starting"]).toContain(child.state);
    expect(sup.status().ok).toBe(false);
    // 20, 40, 80, 80: the delay doubles to the cap.
    const delays = events
      .map((e) => /restart in (\d+)ms/.exec(e)?.[1])
      .filter(Boolean)
      .map(Number);
    expect(delays.slice(0, 3)).toEqual([20, 40, 80]);
    // The status file mirrors status() for the hub's /healthz.
    const onDisk = JSON.parse(readFileSync(join(dir, "status.json"), "utf-8")) as {
      children: { id: string }[];
    };
    expect(onDisk.children[0]!.id).toBe("crashy");
  });

  it("stays alive while a restart is pending", () => {
    // The health timer may stay unref'd: its child holds the loop open. The
    // restart timer may not, or a supervisor whose children are all down
    // exits mid-backoff and nothing ever restarts them.
    const src = readFileSync(join(import.meta.dirname, "../src/host/supervisor.ts"), "utf-8");
    expect(src).not.toMatch(/restartTimer\.unref/);
  });

  it("a binary that cannot be spawned is restarted, not reported up", async () => {
    const dir = tmp();
    const sup = new Supervisor({ backoff: { initialMs: 50, maxMs: 100, stableMs: 10_000 } });
    sups.push(sup);
    // ENOENT arrives as an "error" event with no pid and no "exit".
    sup.start({
      args: [],
      cmd: join(dir, "no-such-binary"),
      id: "ghost",
      log: join(dir, "ghost.log"),
    });
    await until(() => sup.status().children[0]!.restarts >= 2);
    const [ghost] = sup.status().children;
    expect(ghost!.state).toBe("restarting");
    expect(ghost!.pid).toBeNull();
    expect(sup.status().ok).toBe(false);
  });

  it("a one-shot child that exits 0 is done, not restarted", async () => {
    const dir = tmp();
    const sup = new Supervisor();
    sups.push(sup);
    sup.start({ ...node("0"), id: "desk-up", log: join(dir, "desk.log"), oneShot: true });
    await until(() => sup.status().children[0]!.state === "done");
    expect(sup.status().ok).toBe(true);
    expect(sup.status().children[0]!.restarts).toBe(0);
  });

  it("probes health, reports a failing child, and stops on request", async () => {
    const dir = tmp();
    const health = await healthServer();
    const sup = new Supervisor({ healthEveryMs: 30, healthTimeoutMs: 500 });
    sups.push(sup);
    sup.start({
      ...node("setInterval(() => {}, 1000)"),
      healthUrl: health.url,
      id: "eve",
      log: join(dir, "eve.log"),
    });
    try {
      await until(() => sup.status().children[0]!.state === "up");
      expect(sup.status().ok).toBe(true);
      health.set(false);
      await until(() => sup.status().children[0]!.healthy === false);
      expect(sup.status().ok).toBe(false);
      health.set(true);
      await until(() => sup.status().children[0]!.healthy === true);
      await sup.stop("eve", 500);
      expect(sup.status().children[0]!.state).toBe("stopped");
      expect(sup.status().children[0]!.pid).toBeNull();
    } finally {
      await health.close();
    }
  });

  it("restart brings a stopped child back", async () => {
    const dir = tmp();
    const sup = new Supervisor();
    sups.push(sup);
    sup.start({ ...node("setInterval(() => {}, 1000)"), id: "eve", log: join(dir, "eve.log") });
    await until(() => sup.status().children[0]!.state === "up");
    const first = sup.status().children[0]!.pid;
    await sup.restart("eve", 500);
    await until(() => sup.status().children[0]!.state === "up");
    expect(sup.status().children[0]!.pid).not.toBe(first);
  });
});
