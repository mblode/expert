import { spawn } from "node:child_process";
import { ComputerError, clampCursor, asPoint, type Button, type Point } from "@computer/shared";
import type { Desk, FocusHint, ShellResult } from "./types.ts";

export type DockerDeskOptions = {
  container: string;
  user?: string;
};

const BUTTON_TO_UINPUT: Record<Button, string> = {
  left: "left",
  right: "right",
  middle: "middle",
  back: "back",
  forward: "forward",
};

/**
 * Desk driver: docker exec into the box.
 * Pointer goes through /usr/local/bin/uinputd (not XSendEvent).
 */
export class DockerDesk implements Desk {
  private readonly container: string;
  private readonly user: string;
  private cursor = asPoint(640, 400);
  private held = false;

  constructor(opts: DockerDeskOptions) {
    this.container = opts.container;
    this.user = opts.user ?? "box";
  }

  getCursor(): Point {
    return this.cursor;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.exec(["/usr/local/bin/uinputd", "ping"], { timeoutMs: 5000 });
      if (r.exit !== 0) throw new Error(r.stderr);
      return true;
    } catch (err) {
      throw new ComputerError("DAEMON_DOWN", err instanceof Error ? err.message : "desk exec or input is dead");
    }
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot"], { timeoutMs: 15_000, binary: true });
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr.toString() || "screenshot failed");
    }
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  }

  async zoom(x: number, y: number, w: number, h: number): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot", `${x},${y},${w},${h}`], {
      timeoutMs: 15_000,
      binary: true,
    });
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr.toString() || "zoom failed");
    }
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  }

  async click(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    await this.uinput(["click", BUTTON_TO_UINPUT[button]]);
  }

  async doubleClick(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    await this.uinput(["click", BUTTON_TO_UINPUT[button], "--double"]);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.move(x, y);
    await this.uinput(["scroll", String(dx), String(dy)]);
  }

  async keypress(keys: string[]): Promise<void> {
    await this.uinput(["key", ...keys]);
  }

  async type(text: string): Promise<void> {
    // Unicode via clipboard + ctrl+v (uinput cannot emit arbitrary codepoints).
    await this.clipboardSet(text);
    await this.uinput(["key", "ctrl", "v"]);
  }

  async move(x: number, y: number): Promise<void> {
    this.cursor = asPoint(x, y);
    await this.uinput(["move", String(x), String(y)]);
  }

  async drag(path: Point[]): Promise<void> {
    const first = path[0];
    if (!first) return;
    await this.move(first.x, first.y);
    await this.uinput(["down", "left"]);
    for (const p of path.slice(1)) {
      await this.move(p.x, p.y);
    }
    await this.uinput(["up", "left"]);
  }

  async pointerDelta(dx: number, dy: number, grab = false): Promise<Point> {
    this.cursor = clampCursor(this.cursor.x + dx, this.cursor.y + dy);
    if (grab && !this.held) {
      await this.uinput(["down", "left"]);
      this.held = true;
    }
    if (!grab && this.held) {
      await this.uinput(["up", "left"]);
      this.held = false;
    }
    await this.uinput(["move", String(this.cursor.x), String(this.cursor.y)]);
    return this.cursor;
  }

  async pointerClick(button: Button): Promise<Point> {
    await this.uinput(["click", BUTTON_TO_UINPUT[button]]);
    return this.cursor;
  }

  async clipboardGet(): Promise<string> {
    const r = await this.exec(
      ["bash", "-lc", "xclip -selection clipboard -o 2>/dev/null || true"],
      { timeoutMs: 5000, envDisplay: true },
    );
    return r.stdout.toString();
  }

  async clipboardSet(text: string): Promise<void> {
    const r = await this.exec(["bash", "-lc", "xclip -selection clipboard -i"], {
      timeoutMs: 5000,
      stdin: text,
      envDisplay: true,
    });
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr.toString() || "clipboard set failed");
    }
  }

  async shell(argv: string[], cwd: string, timeoutSec: number): Promise<ShellResult> {
    const r = await this.exec(argv, {
      timeoutMs: timeoutSec * 1000,
      cwd,
      envDisplay: true,
    });
    const stdout = r.stdout.toString();
    const stderr = r.stderr.toString();
    const cap = 200_000;
    return {
      exit: r.exit,
      stdout: stdout.slice(0, cap),
      stderr: stderr.slice(0, cap),
      stdout_truncated: stdout.length > cap,
      stderr_truncated: stderr.length > cap,
    };
  }

  async readFile(path: string): Promise<string> {
    const r = await this.exec(["cat", path], { timeoutMs: 15_000 });
    if (r.exit !== 0) {
      throw new ComputerError("VALIDATION", r.stderr.toString() || `read failed: ${path}`);
    }
    return r.stdout.toString("utf8");
  }

  async writeFile(path: string, content: string): Promise<number> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/workspace";
    const r = await this.exec(["bash", "-lc", `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`], {
      timeoutMs: 15_000,
      stdin: content,
    });
    if (r.exit !== 0) {
      throw new ComputerError("VALIDATION", r.stderr.toString() || `write failed: ${path}`);
    }
    return Buffer.byteLength(content, "utf8");
  }

  async focusHint(): Promise<FocusHint> {
    const r = await this.exec(
      ["bash", "-lc", "xdotool getactivewindow getwindowname 2>/dev/null || true"],
      { timeoutMs: 3000, envDisplay: true },
    );
    const title = r.stdout.toString().trim();
    const lower = title.toLowerCase();
    return {
      title,
      password: /password|passcode|authentication|sudo/.test(lower),
      confirm: /are you sure|confirm|delete|overwrite|uninstall/.test(lower),
    };
  }

  private async uinput(args: string[]): Promise<void> {
    const r = await this.exec(["/usr/local/bin/uinputd", ...args], { timeoutMs: 5000, user: "root" });
    if (r.exit !== 0) {
      throw new ComputerError("DAEMON_DOWN", r.stderr.toString() || `uinputd ${args[0]} failed`);
    }
  }

  private exec(
    argv: string[],
    opts: {
      timeoutMs: number;
      cwd?: string;
      stdin?: string;
      binary?: boolean;
      envDisplay?: boolean;
      user?: string;
    },
  ): Promise<{ exit: number; stdout: Buffer; stderr: Buffer }> {
    const dockerArgv = [
      "exec",
      "-i",
      "-u",
      opts.user ?? this.user,
      ...(opts.envDisplay ? ["-e", "DISPLAY=:1"] : []),
      ...(opts.cwd ? ["-w", opts.cwd] : []),
      this.container,
      ...argv,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("docker", dockerArgv, { stdio: ["pipe", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => stdout.push(c));
      child.stderr.on("data", (c: Buffer) => stderr.push(c));
      if (opts.stdin !== undefined) {
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
      const t = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new ComputerError("DAEMON_DOWN", `docker exec timed out: ${argv[0]}`));
      }, opts.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(t);
        reject(new ComputerError("DAEMON_DOWN", err.message));
      });
      child.on("close", (code) => {
        clearTimeout(t);
        resolve({
          exit: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });
    });
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
