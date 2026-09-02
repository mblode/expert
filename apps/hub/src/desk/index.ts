import { FakeDesk } from "./fake.ts";
import { DockerDesk } from "./docker.ts";
import type { Desk } from "./types.ts";

export { DockerWindowManager, LocalWindowManager, NoopWindowManager } from "./windows.ts";

export function createDesk(display = 1): Desk {
  const mode = process.env.COMPUTER_DESK ?? "fake";
  if (mode === "local") {
    return new DockerDesk({ display, transport: "local" });
  }
  if (mode === "docker") {
    return new DockerDesk({
      container: process.env.COMPUTER_DESK_CONTAINER ?? "computer-desk",
      display,
    });
  }
  return new FakeDesk({ display });
}
