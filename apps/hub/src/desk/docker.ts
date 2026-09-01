import { spawn } from "node:child_process";
import {
  ComputerError,
  asPoint,
  clampCursor,
  unavailable,
  type Button,
  type Point,
  type Unavailable,
} from "@computer/shared";
import type { Desk, FocusHint, ShellResult } from "./types.ts";

/**
 * "DAEMON_DOWN" on its own tells a phone nothing. `docker exec` failures
 * differ in ways that matter to a client deciding whether to retry, and this
 * is the whole of what this box can honestly tell apart. Anything it cannot
 * distinguish stays `unknown` rather than being guessed at — and neither
 * `hibernated` nor `idle_timeout` is reachable here, because there is no
 * hibernation and nothing idles out.
 */
export function classifyDeskFailure(text: string): Unavailable {
  const t = text.toLowerCase();
  // The docker CLI itself is missing or unusable: no route to any box, and a
  // retry will not conjure one.
  if (/enoent|docker: not found|command not found|cannot connect to the docker daemon/.test(t)) {
    return unavailable("not_bound", "route_missing");
  }
  if (/no such container|is not running|is restarting/.test(t)) {
    return unavailable("instance_gone", "attach");
  }
  // We killed it, so the command's fate is unknown — the box may be fine.
  if (/timed out/.test(t)) return unavailable("unknown", "in_flight_cancelled");
  // Container answers but the X server on this display does not.
  if (/n't open display|not open display/.test(t)) {
    return unavailable("shutdown", "attach");
  }
  return unavailable("unknown", "attach");
}

function deskDown(message: string): ComputerError {
  return new ComputerError("DAEMON_DOWN", message, classifyDeskFailure(message));
}

export type DockerDeskOptions = {
  container: string;
  user?: string;
  /** Window index = X display number. Default 1 (primary). */
  display?: number;
};

const BUTTON_TO_XDOTOOL: Record<Button, string> = {
  left: "1",
  middle: "2",
  right: "3",
  back: "8",
  forward: "9",
};

/**
 * Agent key name → X keysym.
 *
 * A bare letter or digit is case-insensitive in a chord, and must be lowered:
 * xdotool reads an uppercase keysym as shift+key, so ["CTRL","L"] would send
 * ctrl+shift+l and silently do something else. A capital comes from an
 * explicit "shift" in the key list. Longer unlisted names (F5, Page_Up) are
 * already keysyms and pass through untouched.
 */
export function toKeysym(key: string): string {
  const named = KEY_TO_KEYSYM[key.toLowerCase()];
  if (named) return named;
  return key.length === 1 ? key.toLowerCase() : key;
}

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
 * All input is XTEST via `xdotool` with `DISPLAY=:N` — real synthesized
 * input at the X server, honoured by GTK and Chromium, and per-display.
 * Never XSendEvent, which GTK ignores.
 */
export class DockerDesk implements Desk {
  private readonly container: string;
  private readonly user: string;
  readonly display: number;
  private cursor = asPoint(640, 400);
  private held = false;

  constructor(opts: DockerDeskOptions) {
    this.container = opts.container;
    this.user = opts.user ?? "box";
    this.display = opts.display ?? 1;
  }

  getCursor(): Point {
    return this.cursor;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.exec(["xdotool", "getdisplaygeometry"], { timeoutMs: 5000 });
      if (r.exit !== 0) throw new Error(r.stderr.toString());
      return true;
    } catch (err) {
      if (err instanceof ComputerError) throw err;
      throw deskDown(err instanceof Error ? err.message : "desk exec or input is dead");
    }
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot"], { timeoutMs: 15_000, binary: true });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || "screenshot failed");
    }
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  }

  async zoom(x: number, y: number, w: number, h: number): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot", `${x},${y},${w},${h}`], {
      timeoutMs: 15_000,
      binary: true,
    });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || "zoom failed");
    }
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  }

  async click(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    await this.clickButton(button);
  }

  async doubleClick(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    await this.clickButton(button, true);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.move(x, y);
    await this.scrollBy(dx, dy);
  }

  async keypress(keys: string[]): Promise<void> {
    await this.sendKeys(keys);
  }

  async type(text: string): Promise<void> {
    // Unicode via clipboard + ctrl+v (XTEST keysyms cannot cover every codepoint).
    await this.clipboardSet(text);
    await this.sendKeys(["ctrl", "v"]);
  }

  async move(x: number, y: number): Promise<void> {
    this.cursor = asPoint(x, y);
    await this.moveTo(x, y);
  }

  async drag(path: Point[]): Promise<void> {
    const first = path[0];
    if (!first) return;
    await this.move(first.x, first.y);
    await this.mouseDown("left");
    for (const p of path.slice(1)) {
      await this.move(p.x, p.y);
    }
    await this.mouseUp("left");
  }

  async pointerDelta(dx: number, dy: number, grab = false): Promise<Point> {
    this.cursor = clampCursor(this.cursor.x + dx, this.cursor.y + dy);
    if (grab && !this.held) {
      await this.mouseDown("left");
      this.held = true;
    }
    if (!grab && this.held) {
      await this.mouseUp("left");
      this.held = false;
    }
    await this.moveTo(this.cursor.x, this.cursor.y);
    return this.cursor;
  }

  async pointerClick(button: Button): Promise<Point> {
    await this.clickButton(button);
    return this.cursor;
  }

  async clipboardGet(): Promise<string> {
    const r = await this.exec(
      ["bash", "-lc", "xclip -selection clipboard -o 2>/dev/null || true"],
      { timeoutMs: 5000 },
    );
    return r.stdout.toString();
  }

  async clipboardSet(text: string): Promise<void> {
    const r = await this.exec(["bash", "-lc", "xclip -selection clipboard -i"], {
      timeoutMs: 5000,
      stdin: text,
    });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || "clipboard set failed");
    }
  }

  async shell(argv: string[], cwd: string, timeoutSec: number): Promise<ShellResult> {
    const r = await this.exec(argv, {
      timeoutMs: timeoutSec * 1000,
      cwd,
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
    return this.put(path, content, ">");
  }

  async appendFile(path: string, content: string): Promise<number> {
    return this.put(path, content, ">>");
  }

  /** Truncate or append; the parent directory is made either way. */
  private async put(path: string, content: string, redirect: ">" | ">>"): Promise<number> {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/workspace";
    const r = await this.exec(
      ["bash", "-lc", `mkdir -p ${shellQuote(dir)} && cat ${redirect} ${shellQuote(path)}`],
      { timeoutMs: 15_000, stdin: content },
    );
    if (r.exit !== 0) {
      throw new ComputerError("VALIDATION", r.stderr.toString() || `write failed: ${path}`);
    }
    return Buffer.byteLength(content, "utf8");
  }

  async focusHint(): Promise<FocusHint> {
    const r = await this.exec(
      ["bash", "-lc", "xdotool getactivewindow getwindowname 2>/dev/null || true"],
      { timeoutMs: 3000 },
    );
    const title = r.stdout.toString().trim();
    const lower = title.toLowerCase();
    return {
      title,
      password: /password|passcode|authentication|sudo/.test(lower),
      confirm: /are you sure|confirm|delete|overwrite|uninstall/.test(lower),
    };
  }

  /** One xdotool invocation (XTEST) against this window's display. */
  private async xdotool(...argv: string[]): Promise<void> {
    const r = await this.exec(["xdotool", ...argv], { timeoutMs: 5000 });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || `xdotool ${argv[0]} failed`);
    }
  }

  private moveTo(x: number, y: number): Promise<void> {
    return this.xdotool("mousemove", String(x), String(y));
  }

  private clickButton(button: Button, double = false): Promise<void> {
    const b = BUTTON_TO_XDOTOOL[button];
    return double
      ? this.xdotool("click", "--repeat", "2", "--delay", "150", b)
      : this.xdotool("click", b);
  }

  private mouseDown(button: Button): Promise<void> {
    return this.xdotool("mousedown", BUTTON_TO_XDOTOOL[button]);
  }

  private mouseUp(button: Button): Promise<void> {
    return this.xdotool("mouseup", BUTTON_TO_XDOTOOL[button]);
  }

  /** Wheel buttons: 4/5 vertical, 6/7 horizontal. */
  private async scrollBy(dx: number, dy: number): Promise<void> {
    const y = Math.trunc(dy);
    const x = Math.trunc(dx);
    if (y !== 0) await this.xdotool("click", "--repeat", String(Math.abs(y)), y > 0 ? "5" : "4");
    if (x !== 0) await this.xdotool("click", "--repeat", String(Math.abs(x)), x > 0 ? "7" : "6");
  }

  private async sendKeys(keys: string[]): Promise<void> {
    const combo = keys.map(toKeysym).join("+");
    if (combo) await this.xdotool("key", combo);
  }

  private exec(
    argv: string[],
    opts: {
      timeoutMs: number;
      cwd?: string;
      stdin?: string;
      binary?: boolean;
      user?: string;
    },
  ): Promise<{ exit: number; stdout: Buffer; stderr: Buffer }> {
    const dockerArgv = [
      "exec",
      "-i",
      "-u",
      opts.user ?? this.user,
      // Always: this driver *is* one window, and a command that forgets its
      // DISPLAY silently targets :1 — which made every fork Bot screenshot
      // screen 1 while acting on its own.
      "-e",
      `DISPLAY=:${this.display}`,
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
        reject(deskDown(`docker exec timed out: ${argv[0]}`));
      }, opts.timeoutMs);
      child.on("error", (err) => {
        clearTimeout(t);
        // spawn ENOENT lands here: `${code}: ${message}` so the classifier sees it.
        reject(deskDown(`${(err as NodeJS.ErrnoException).code ?? ""} ${err.message}`.trim()));
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
