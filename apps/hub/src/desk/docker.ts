import { spawn } from "node:child_process";
import { ComputerError, clampCursor, asPoint, type Button, type Point } from "@computer/shared";
import type { Desk, FocusHint, ShellResult } from "./types.ts";

export type InputBackend = "uinput" | "xtest";

export type DockerDeskOptions = {
  container: string;
  user?: string;
  /** Window index = X display number. Default 1 (primary). */
  display?: number;
  /**
   * Default XTEST (xdotool with DISPLAY=:N): real synthesized input at the
   * X server, honoured by GTK and Chromium, and per-display.
   *
   * uinput is kernel-global and injects into the kernel input layer, which
   * a virtual X server (Xvnc) never reads — verified: `uinputd move` exits
   * 0 and the pointer does not move. Opt in only for a real Xorg desktop
   * on hardware. Neither path is XSendEvent, which GTK ignores.
   */
  inputBackend?: InputBackend;
};

const BUTTON_TO_UINPUT: Record<Button, string> = {
  left: "left",
  right: "right",
  middle: "middle",
  back: "back",
  forward: "forward",
};

const BUTTON_TO_XDOTOOL: Record<Button, string> = {
  left: "1",
  middle: "2",
  right: "3",
  back: "8",
  forward: "9",
};

/** Agent key names → X keysyms for xdotool. Unlisted names pass through. */
const KEY_TO_KEYSYM: Record<string, string> = {
  enter: "Return",
  return: "Return",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  tab: "Tab",
  space: "space",
  delete: "Delete",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  super: "super",
  cmd: "super",
};

/**
 * Desk driver for one window (X display) of the box: docker exec in.
 * Pointer goes through uinputd on the primary window and XTEST on forks
 * (never XSendEvent).
 */
export class DockerDesk implements Desk {
  private readonly container: string;
  private readonly user: string;
  readonly display: number;
  readonly inputBackend: InputBackend;
  private cursor = asPoint(640, 400);
  private held = false;

  constructor(opts: DockerDeskOptions) {
    this.container = opts.container;
    this.user = opts.user ?? "box";
    this.display = opts.display ?? 1;
    this.inputBackend = opts.inputBackend ?? "xtest";
  }

  getCursor(): Point {
    return this.cursor;
  }

  async ping(): Promise<boolean> {
    try {
      const r =
        this.inputBackend === "uinput"
          ? await this.exec(["/usr/local/bin/uinputd", "ping"], { timeoutMs: 5000 })
          : await this.exec(["xdotool", "getdisplaygeometry"], { timeoutMs: 5000, envDisplay: true });
      if (r.exit !== 0) throw new Error(r.stderr.toString());
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

  /** Input verbs in uinputd vocabulary; translated to xdotool on the xtest backend. */
  private async uinput(args: string[]): Promise<void> {
    if (this.inputBackend === "xtest") {
      for (const argv of xdotoolArgv(args)) {
        const r = await this.exec(argv, { timeoutMs: 5000, envDisplay: true });
        if (r.exit !== 0) {
          throw new ComputerError("DAEMON_DOWN", r.stderr.toString() || `xdotool ${args[0]} failed`);
        }
      }
      return;
    }
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
      ...(opts.envDisplay ? ["-e", `DISPLAY=:${this.display}`] : []),
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

/** uinputd verb → xdotool argv list (XTEST; per-display, unlike uinput). */
function xdotoolArgv(args: string[]): string[][] {
  const [verb, ...rest] = args;
  switch (verb) {
    case "move":
      return [["xdotool", "mousemove", rest[0] ?? "0", rest[1] ?? "0"]];
    case "click": {
      const button = BUTTON_TO_XDOTOOL[(rest[0] ?? "left") as Button] ?? "1";
      return rest.includes("--double")
        ? [["xdotool", "click", "--repeat", "2", "--delay", "150", button]]
        : [["xdotool", "click", button]];
    }
    case "down":
      return [["xdotool", "mousedown", BUTTON_TO_XDOTOOL[(rest[0] ?? "left") as Button] ?? "1"]];
    case "up":
      return [["xdotool", "mouseup", BUTTON_TO_XDOTOOL[(rest[0] ?? "left") as Button] ?? "1"]];
    case "scroll": {
      const dx = Math.trunc(Number(rest[0] ?? 0));
      const dy = Math.trunc(Number(rest[1] ?? 0));
      const out: string[][] = [];
      if (dy !== 0) out.push(["xdotool", "click", "--repeat", String(Math.abs(dy)), dy > 0 ? "5" : "4"]);
      if (dx !== 0) out.push(["xdotool", "click", "--repeat", String(Math.abs(dx)), dx > 0 ? "7" : "6"]);
      return out;
    }
    case "key": {
      const combo = rest.map((k) => KEY_TO_KEYSYM[k.toLowerCase()] ?? k).join("+");
      return combo ? [["xdotool", "key", combo]] : [];
    }
    default:
      return [["xdotool", verb ?? "version", ...rest]];
  }
}
