import { asPoint, clampCursor, ComputerError, unavailable } from "@computer/shared";
import type { Button, Point } from "@computer/shared";
import type { Desk, FocusHint, ShellResult } from "./types.ts";

/** Minimal valid 1×1 PNG. Tests do not decode pixels. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

interface FileEntry {
  content: string;
}

export interface FakeDeskOptions {
  failPing?: boolean;
  display?: number;
}

export class FakeDesk implements Desk {
  readonly display: number;
  cursor: Point = asPoint(640, 400);
  clipboard = "";
  files = new Map<string, FileEntry>();
  log: string[] = [];
  hint: FocusHint = { confirm: false, password: false, title: "" };
  lastKeys: string[] = [];
  lastType = "";
  grabs = 0;
  failPing: boolean;
  /** A keypress containing this key throws, to exercise the skip-the-rest rule. */
  failKeys: string | undefined;

  constructor(opts: FakeDeskOptions = {}) {
    this.failPing = opts.failPing ?? false;
    this.display = opts.display ?? 1;
  }

  async ping(): Promise<boolean> {
    // Detail included: a fake that drops it would hide the envelope regression.
    if (this.failPing) {
      throw new ComputerError(
        "DAEMON_DOWN",
        "desk exec or input is dead",
        unavailable("instance_gone", "attach"),
      );
    }
    return true;
  }

  async screenshot(): Promise<Buffer> {
    this.log.push("screenshot");
    return TINY_PNG;
  }

  async zoom(x: number, y: number, w: number, h: number): Promise<Buffer> {
    this.log.push(`zoom ${x},${y} ${w}x${h}`);
    return TINY_PNG;
  }

  async click(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    this.log.push(`click ${button} ${x},${y}`);
  }

  async doubleClick(x: number, y: number, button: Button): Promise<void> {
    await this.move(x, y);
    this.log.push(`double_click ${button} ${x},${y}`);
  }

  async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
    await this.move(x, y);
    this.log.push(`scroll ${x},${y} ${dx},${dy}`);
  }

  async keypress(keys: string[]): Promise<void> {
    if (this.failKeys && keys.includes(this.failKeys)) {
      throw new Error("xdotool key failed");
    }
    this.lastKeys = keys;
    this.log.push(`keypress ${keys.join("+")}`);
  }

  async type(text: string): Promise<void> {
    this.lastType = text;
    this.log.push(`type ${text.length}`);
  }

  async move(x: number, y: number): Promise<void> {
    this.cursor = asPoint(x, y);
    this.log.push(`move ${x},${y}`);
  }

  async drag(path: Point[]): Promise<void> {
    const last = path.at(-1);
    if (last) {
      this.cursor = last;
    }
    this.log.push(`drag ${path.length}`);
  }

  async pointerDelta(dx: number, dy: number, grab = false): Promise<Point> {
    this.cursor = clampCursor(this.cursor.x + dx, this.cursor.y + dy);
    if (grab) {
      this.grabs += 1;
    }
    this.log.push(`delta ${dx},${dy}${grab ? " grab" : ""}`);
    return this.cursor;
  }

  async pointerClick(button: Button): Promise<Point> {
    this.log.push(`pointer_click ${button}`);
    return this.cursor;
  }

  getCursor(): Point {
    return this.cursor;
  }

  async clipboardGet(): Promise<string> {
    return this.clipboard;
  }

  async clipboardSet(text: string): Promise<void> {
    this.clipboard = text;
  }

  async shell(argv: string[], cwd: string, timeoutSec: number): Promise<ShellResult> {
    this.log.push(`shell ${argv.join(" ")} cwd=${cwd} t=${timeoutSec}`);
    if (argv[0] === "false") {
      return {
        exit: 1,
        stderr: "false",
        stderr_truncated: false,
        stdout: "",
        stdout_truncated: false,
      };
    }
    if (argv[0] === "echo") {
      return {
        exit: 0,
        stderr: "",
        stderr_truncated: false,
        stdout: `${argv.slice(1).join(" ")}\n`,
        stdout_truncated: false,
      };
    }
    return {
      exit: 0,
      stderr: "",
      stderr_truncated: false,
      stdout: "",
      stdout_truncated: false,
    };
  }

  async readFile(path: string): Promise<string> {
    const f = this.files.get(path);
    if (!f) {
      throw new ComputerError("VALIDATION", `no such file: ${path}`);
    }
    return f.content;
  }

  async writeFile(path: string, content: string): Promise<number> {
    this.files.set(path, { content });
    return Buffer.byteLength(content, "utf-8");
  }

  async focusHint(): Promise<FocusHint> {
    return this.hint;
  }
}
