import type { Button, Point } from "@computer/shared";

export type ShellResult = {
  exit: number;
  stdout: string;
  stderr: string;
  stdout_truncated: boolean;
  stderr_truncated: boolean;
};

export type FocusHint = {
  title: string;
  password: boolean;
  confirm: boolean;
};

export interface Desk {
  ping(): Promise<boolean>;
  screenshot(): Promise<Buffer>;
  zoom(x: number, y: number, w: number, h: number): Promise<Buffer>;
  click(x: number, y: number, button: Button): Promise<void>;
  doubleClick(x: number, y: number, button: Button): Promise<void>;
  scroll(x: number, y: number, dx: number, dy: number): Promise<void>;
  keypress(keys: string[]): Promise<void>;
  type(text: string): Promise<void>;
  move(x: number, y: number): Promise<void>;
  drag(path: Point[]): Promise<void>;
  pointerDelta(dx: number, dy: number, grab?: boolean): Promise<Point>;
  pointerClick(button: Button): Promise<Point>;
  getCursor(): Point;
  clipboardGet(): Promise<string>;
  clipboardSet(text: string): Promise<void>;
  shell(argv: string[], cwd: string, timeoutSec: number): Promise<ShellResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<number>;
  focusHint(): Promise<FocusHint>;
}

export const PNG_MEDIA = "image/png";
