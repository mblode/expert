import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ComputerError } from "@computer/shared";

/**
 * Claims and releases window indexes (X displays) on the box.
 * Owner identity on the box is a sha256 of the bot token — the raw
 * bearer never lands on the shared filesystem.
 */
export interface WindowManager {
  startWindow(display: number, ownerToken: string, botId: string, force?: boolean): Promise<void>;
  stopWindow(display: number): Promise<void>;
}

export function ownerHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class DockerWindowManager implements WindowManager {
  constructor(
    private readonly container: string,
    private readonly user = "box",
  ) {}

  async startWindow(display: number, ownerToken: string, botId: string, force = false): Promise<void> {
    const argv = ["/usr/local/bin/start-window", String(display), ownerHash(ownerToken), botId];
    if (force) argv.push("--force");
    const r = await this.exec(argv);
    if (r.exit === 9) {
      throw new ComputerError("CONFLICT", `window ${display} claimed by another owner`);
    }
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr || `start-window ${display} failed`);
    }
  }

  async stopWindow(display: number): Promise<void> {
    const r = await this.exec(["/usr/local/bin/stop-window", String(display)]);
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr || `stop-window ${display} failed`);
    }
  }

  private exec(argv: string[]): Promise<{ exit: number; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("docker", ["exec", "-u", this.user, this.container, ...argv], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr.on("data", (c: Buffer) => stderr.push(c));
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ComputerError("DAEMON_DOWN", `docker exec timed out: ${argv[0]}`));
      }, 30_000);
      child.on("error", (err) => {
        clearTimeout(t);
        reject(new ComputerError("DAEMON_DOWN", err.message));
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({ exit: code ?? 1, stderr: Buffer.concat(stderr).toString() });
      });
    });
  }
}

export class NoopWindowManager implements WindowManager {
  started: number[] = [];
  stopped: number[] = [];
  forced: number[] = [];
  failNext = false;

  async startWindow(display: number, _ownerToken?: string, _botId?: string, force = false): Promise<void> {
    if (force) this.forced.push(display);
    if (this.failNext) {
      this.failNext = false;
      throw new ComputerError("DAEMON_DOWN", `start-window ${display} failed`);
    }
    this.started.push(display);
  }

  async stopWindow(display: number): Promise<void> {
    this.stopped.push(display);
  }
}
