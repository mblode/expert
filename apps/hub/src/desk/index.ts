import { FakeDesk } from "./fake.ts";
import { DockerDesk, type InputBackend } from "./docker.ts";
import type { Desk } from "./types.ts";

export type { Desk, ShellResult, FocusHint } from "./types.ts";
export { FakeDesk, TINY_PNG } from "./fake.ts";
export { DockerDesk } from "./docker.ts";
export type { InputBackend } from "./docker.ts";
export { PNG_MEDIA } from "./types.ts";
export { DockerWindowManager, NoopWindowManager, ownerHash, type WindowManager } from "./windows.ts";

export function createDesk(display = 1): Desk {
  const mode = process.env.COMPUTER_DESK ?? "fake";
  if (mode === "docker") {
    return new DockerDesk({
      container: process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk",
      display,
      inputBackend: parseBackend(process.env.COMPUTER_INPUT_BACKEND, display),
    });
  }
  return new FakeDesk({ display });
}

function parseBackend(v: string | undefined, display: number): InputBackend | undefined {
  // Explicit override applies to every window; default is uinput on :1, xtest on forks.
  if (v === "uinput" || v === "xtest") return v;
  void display;
  return undefined;
}
