import { FakeDesk } from "./fake.ts";
import { DockerDesk } from "./docker.ts";
import type { Desk } from "./types.ts";

export type { Desk, ShellResult, FocusHint } from "./types.ts";
export { FakeDesk, TINY_PNG } from "./fake.ts";
export { DockerDesk } from "./docker.ts";
export { PNG_MEDIA } from "./types.ts";

export function createDesk(): Desk {
  const mode = process.env.COMPUTER_DESK ?? "fake";
  if (mode === "docker") {
    return new DockerDesk({
      container: process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk",
    });
  }
  return new FakeDesk();
}
