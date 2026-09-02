import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { ComputerError, asPoint, clampCursor, unavailable } from "@computer/shared";
import type { Button, Point, Unavailable } from "@computer/shared";
import type { Desk, FocusHint, ShellResult } from "./types.ts";

/**
 * "DAEMON_DOWN" on its own tells a phone nothing. Desk exec failures
 * differ in ways that matter to a client deciding whether to retry, and this
 * is the whole of what this box can honestly tell apart. Anything it cannot
 * distinguish stays `unknown` rather than being guessed at.
 *
 * `hibernated` is a *host* state (Fly Machine suspend/stop). The guest
 * cannot observe it: when the Machine is asleep this process is not
 * running. Idle timeout is the Fly proxy's, not ours.
 */
function classifyDeskFailure(text: string): Unavailable {
  const t = text.toLowerCase();
  // The docker CLI itself is missing or unusable: no route to any box, and a
  // retry will not conjure one.
  if (/enoent|docker: not found|command not found|cannot connect to the docker daemon/.test(t)) {
    return unavailable("not_bound", "route_missing");
  }
  if (/no such container|is not running|is restarting/.test(t)) {
    return unavailable("instance_gone", "attach");
  }
  // We killed it, so the command's fate is unknown: the box may be fine.
  if (/timed out/.test(t)) {
    return unavailable("unknown", "in_flight_cancelled");
  }
  // Container answers but the X server on this display does not.
  if (/n't open display|not open display/.test(t)) {
    return unavailable("shutdown", "attach");
  }
  return unavailable("unknown", "attach");
}

function deskDown(message: string): ComputerError {
  return new ComputerError("DAEMON_DOWN", message, classifyDeskFailure(message));
}

export type DeskTransport = "docker" | "local";

export interface DockerDeskOptions {
  /** Required when transport is docker (compose host → desk container). */
  container?: string;
  user?: string;
  /** Window index = X display number. Default 1 (primary). */
  display?: number;
  /**
   * docker: `docker exec` into the desk container (local compose).
   * local: same namespace as the hub (Fly Machine / cloud guest).
   */
  transport?: DeskTransport;
}

const BUTTON_TO_XDOTOOL: Record<Button, string> = {
  back: "8",
  forward: "9",
  left: "1",
  middle: "2",
  right: "3",
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
  if (named) {
    return named;
  }
  return key.length === 1 ? key.toLowerCase() : key;
}

/** Agent key names → X keysyms for xdotool. Unlisted names pass through. */
const KEY_TO_KEYSYM: Record<string, string> = {
  alt: "alt",
  backspace: "BackSpace",
  cmd: "super",
  ctrl: "ctrl",
  delete: "Delete",
  down: "Down",
  end: "End",
  enter: "Return",
  esc: "Escape",
  escape: "Escape",
  home: "Home",
  left: "Left",
  pagedown: "Page_Down",
  pageup: "Page_Up",
  return: "Return",
  right: "Right",
  shift: "shift",
  space: "space",
  super: "super",
  tab: "Tab",
  up: "Up",
};

/**
 * Desk driver for one window (X display) of the box: docker exec in.
 * All input is XTEST via `xdotool` with `DISPLAY=:N`: real synthesized
 * input at the X server, honoured by GTK and Chromium, and per-display.
 * Never XSendEvent, which GTK ignores.
 */
export class DockerDesk implements Desk {
  private readonly container: string;
  private readonly user: string;
  private readonly transport: DeskTransport;
  readonly display: number;
  private cursor = asPoint(640, 400);
  private held = false;

  constructor(opts: DockerDeskOptions) {
    this.transport = opts.transport ?? "docker";
    this.container = opts.container ?? "computer-desk";
    this.user = opts.user ?? "box";
    this.display = opts.display ?? 1;
  }

  getCursor(): Point {
    return this.cursor;
  }

  async ping(): Promise<boolean> {
    try {
      const r = await this.exec(["xdotool", "getdisplaygeometry"], { timeoutMs: 5000 });
      if (r.exit !== 0) {
        throw new Error(r.stderr.toString());
      }
      return true;
    } catch (error) {
      if (error instanceof ComputerError) throw error;
      throw deskDown(error instanceof Error ? error.message : "desk exec or input is dead");
    }
  }

  async screenshot(): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot"], { binary: true, timeoutMs: 15_000 });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || "screenshot failed");
    }
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout);
  }

  async zoom(x: number, y: number, w: number, h: number): Promise<Buffer> {
    const r = await this.exec(["/usr/local/bin/desk-shot", `${x},${y},${w},${h}`], {
      binary: true,
      timeoutMs: 15_000,
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

  /**
   * Unicode via clipboard + ctrl+v: XTEST keysyms cannot cover every
   * codepoint. Two consequences the caller should know: the box clipboard is
   * overwritten by whatever was typed, and ctrl+v is not paste in a terminal
   * emulator (xterm wants shift+insert).
   */
  async type(text: string): Promise<void> {
    await this.clipboardSet(text);
    await this.sendKeys(["ctrl", "v"]);
  }

  async move(x: number, y: number): Promise<void> {
    this.cursor = asPoint(x, y);
    await this.moveTo(x, y);
  }

  async drag(path: Point[]): Promise<void> {
    const [first] = path;
    if (!first) {
      return;
    }
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
    const r = await this.exec(["bash", "-c", "xclip -selection clipboard -o 2>/dev/null || true"], {
      timeoutMs: 5000,
    });
    return r.stdout.toString();
  }

  async clipboardSet(text: string): Promise<void> {
    const r = await this.exec(["bash", "-c", "xclip -selection clipboard -i"], {
      stdin: text,
      timeoutMs: 5000,
    });
    if (r.exit !== 0) {
      throw deskDown(r.stderr.toString() || "clipboard set failed");
    }
  }

  /**
   * The timeout runs *inside* the box: killing the `docker exec` client (or
   * the local child) leaves the workload alive, so coreutils `timeout` wraps
   * the command and delivers the SIGKILL where the process actually is. The
   * hub's own deadline is a little longer, for the exec round trip.
   */
  async shell(argv: string[], cwd: string, timeoutSec: number): Promise<ShellResult> {
    const r = await this.exec(["timeout", "-s", "KILL", `${timeoutSec}s`, ...argv], {
      cwd,
      maxOutput: SHELL_OUTPUT_CAP,
      timeoutMs: timeoutSec * 1000 + 5000,
    });
    return {
      exit: r.exit,
      stderr: r.stderr.toString("utf-8"),
      stderr_truncated: r.stderrTruncated,
      stdout: r.stdout.toString("utf-8"),
      stdout_truncated: r.stdoutTruncated,
    };
  }

  async readFile(path: string): Promise<string> {
    const r = await this.exec(["cat", path], { timeoutMs: 15_000 });
    if (r.exit !== 0) {
      throw fileError(r.stderr.toString(), `read failed: ${path}`);
    }
    return r.stdout.toString("utf-8");
  }

  async writeFile(path: string, content: string): Promise<number> {
    return this.put(path, content, ">");
  }

  async appendFile(path: string, content: string): Promise<number> {
    return this.put(path, content, ">>");
  }

  /** Truncate or append; the parent directory is made either way. `path` is absolute (resolveWorkspacePath). */
  private async put(path: string, content: string, redirect: ">" | ">>"): Promise<number> {
    const dir = dirname(path);
    const r = await this.exec(
      ["bash", "-c", `mkdir -p ${shellQuote(dir)} && cat ${redirect} ${shellQuote(path)}`],
      { stdin: content, timeoutMs: 15_000 },
    );
    if (r.exit !== 0) {
      throw fileError(r.stderr.toString(), `write failed: ${path}`);
    }
    return Buffer.byteLength(content, "utf-8");
  }

  async focusHint(): Promise<FocusHint> {
    const r = await this.exec(
      ["bash", "-c", "xdotool getactivewindow getwindowname 2>/dev/null || true"],
      { timeoutMs: 3000 },
    );
    const title = r.stdout.toString().trim();
    const lower = title.toLowerCase();
    return {
      confirm: /are you sure|confirm|delete|overwrite|uninstall/.test(lower),
      password: /password|passcode|authentication|sudo/.test(lower),
      title,
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
    if (y !== 0) {
      await this.xdotool("click", "--repeat", String(Math.abs(y)), y > 0 ? "5" : "4");
    }
    if (x !== 0) {
      await this.xdotool("click", "--repeat", String(Math.abs(x)), x > 0 ? "7" : "6");
    }
  }

  private async sendKeys(keys: string[]): Promise<void> {
    const combo = keys.map(toKeysym).join("+");
    if (combo) {
      await this.xdotool("key", combo);
    }
  }

  private exec(
    argv: string[],
    opts: {
      timeoutMs: number;
      cwd?: string;
      stdin?: string;
      binary?: boolean;
      /** Bytes kept per stream. Absent = keep everything (screenshots, file reads). */
      maxOutput?: number;
    },
  ): Promise<ExecResult> {
    // The hub is not `box` on the guest (AUDIT P0 #2), so a local command
    // goes through `sudo -u box`: one sudoers line, and the child gets a
    // login's worth of environment and nothing of the hub's.
    const local = this.transport === "local" ? asBox(argv, localEnv(this.display)) : undefined;
    const cmd = local ? local[0]! : "docker";
    const spawnArgv = local
      ? local.slice(1)
      : [
          "exec",
          "-i",
          "-u",
          this.user,
          // Always: this driver *is* one window, and a command that forgets its
          // DISPLAY silently targets :1, which made every fork Bot screenshot
          // screen 1 while acting on its own.
          "-e",
          `DISPLAY=:${this.display}`,
          ...(opts.cwd ? ["-w", opts.cwd] : []),
          this.container,
          ...argv,
        ];
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, spawnArgv, {
        cwd: local ? opts.cwd : undefined,
        env: local ? localEnv(this.display) : process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout = new Sink(opts.maxOutput);
      const stderr = new Sink(opts.maxOutput);
      child.stdout.on("data", (c: Buffer) => stdout.push(c));
      child.stderr.on("data", (c: Buffer) => stderr.push(c));
      child.stdin.on("error", () => {});
      child.stdin.end(opts.stdin);
      const t = setTimeout(() => {
        // sudo relays SIGTERM to its command; SIGKILL would orphan it as box.
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 2000).unref();
        reject(deskDown(`desk exec timed out: ${argv[0]}`));
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
          stderr: stderr.buffer(),
          stderrTruncated: stderr.truncated,
          stdout: stdout.buffer(),
          stdoutTruncated: stdout.truncated,
        });
      });
    });
  }
}

interface ExecResult {
  exit: number;
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/** What `shell` returns per stream. Anything past it is dropped as it arrives, not buffered. */
const SHELL_OUTPUT_CAP = 200_000;

/** Collects a child's output up to a cap, dropping the rest instead of holding it. */
class Sink {
  private readonly chunks: Buffer[] = [];
  private size = 0;
  truncated = false;

  constructor(private readonly max: number | undefined) {}

  push(chunk: Buffer): void {
    if (this.max === undefined) {
      this.chunks.push(chunk);
      return;
    }
    const room = this.max - this.size;
    if (room <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.length > room) {
      this.chunks.push(chunk.subarray(0, room));
      this.size = this.max;
      this.truncated = true;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks);
  }
}

/**
 * The `local` transport shares a process namespace with the hub, so the
 * model's shell would otherwise inherit the hub's environment: every token
 * and key the guest was started with. Hand the box what a login would get and
 * nothing else.
 */
function localEnv(display: number): NodeJS.ProcessEnv {
  return {
    ...boxLogin(),
    DISPLAY: `:${display}`,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
  };
}

/**
 * The login a desk child sees. Under the uid split the hub's own HOME is its
 * 0700 state dir and its USER is `hub`; handing those to a child that runs
 * as box would point every tool that touches `~` at a directory it cannot
 * write. So the login follows `COMPUTER_RUN_AS`, and only falls back to the
 * hub's when there is no split (`npm run up`, tests).
 */
export function boxLogin(): { HOME: string; PATH: string; USER: string } {
  const user = process.env.COMPUTER_RUN_AS;
  return {
    HOME: user ? `/home/${user}` : (process.env.HOME ?? "/home/box"),
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    USER: user ?? process.env.USER ?? "box",
  };
}

/**
 * `COMPUTER_RUN_AS=box` (set by the guest init for the hub) turns a local
 * argv into `sudo -n -u box -- env -i K=V... argv`. `env -i` because sudo
 * would otherwise hand the child sudo's own idea of the environment; the
 * hub's is never in reach. Unset (`npm run up`, tests) the argv runs as is.
 */
export function asBox(argv: string[], env: NodeJS.ProcessEnv): string[] {
  const user = process.env.COMPUTER_RUN_AS;
  if (!user) {
    return argv;
  }
  const pairs = Object.entries(env)
    .filter((kv): kv is [string, string] => typeof kv[1] === "string")
    .map(([k, v]) => `${k}=${v}`);
  return ["sudo", "-n", "-u", user, "--", "env", "-i", ...pairs, ...argv];
}

/** `cat`/`bash` said no. A missing file is the model's mistake; a dead box is not. */
function fileError(stderr: string, fallback: string): ComputerError {
  const message = stderr.trim() || fallback;
  if (/no such file|is a directory|permission denied|not a directory/i.test(message)) {
    return new ComputerError("VALIDATION", message);
  }
  return deskDown(message);
}

function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
