import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execViaSocket, startExecutorServer } from "../src/desk/executor.ts";

/**
 * Not root here, so the server runs as the test user: uid/gid are its own.
 * What is under test is the protocol, the caps and the timeout, which are
 * the same whoever the child runs as.
 */
describe("executor socket", () => {
  const dirs: string[] = [];
  const servers: { close: () => void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) {
      s.close();
    }
    while (dirs.length) {
      rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  const serve = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "hub-exec-"));
    dirs.push(dir);
    const socketPath = join(dir, "exec.sock");
    const uid = process.getuid?.() ?? 0;
    const gid = process.getgid?.() ?? 0;
    const server = startExecutorServer({ clientGid: gid, clientUid: uid, gid, socketPath, uid });
    servers.push(server);
    return socketPath;
  };

  const ready = async (socketPath: string): Promise<void> => {
    for (let i = 0; i < 50; i += 1) {
      try {
        await execViaSocket(socketPath, { argv: ["true"], timeoutMs: 1000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    throw new Error("executor never came up");
  };

  it("runs argv with the given env, cwd and stdin, and returns both streams", async () => {
    const socketPath = serve();
    await ready(socketPath);
    const r = await execViaSocket(socketPath, {
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(process.env.X + process.cwd()); process.stderr.write(require('fs').readFileSync(0, 'utf8')); process.exit(3)",
      ],
      cwd: "/tmp",
      env: { PATH: process.env.PATH ?? "", X: "x-" },
      stdin: "in",
      timeoutMs: 5000,
    });
    expect(r.exit).toBe(3);
    expect(r.stdout.toString()).toBe("x-/tmp");
    expect(r.stderr.toString()).toBe("in");
    expect(r.error).toBeUndefined();
  });

  it("caps output and reports a timeout", async () => {
    const socketPath = serve();
    await ready(socketPath);
    const big = await execViaSocket(socketPath, {
      argv: [process.execPath, "-e", "process.stdout.write('a'.repeat(5000))"],
      maxOutput: 100,
      timeoutMs: 5000,
    });
    expect(big.stdout).toHaveLength(100);
    expect(big.stdoutTruncated).toBe(true);
    const slow = await execViaSocket(socketPath, {
      argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      timeoutMs: 100,
    });
    expect(slow.timedOut).toBe(true);
    expect(slow.error).toMatch(/timed out/);
  });

  it("reports a command that cannot start as an error, not an exit code", async () => {
    const socketPath = serve();
    await ready(socketPath);
    const r = await execViaSocket(socketPath, { argv: ["/no/such/binary"], timeoutMs: 1000 });
    expect(r.error).toMatch(/ENOENT/);
  });
});
