import { afterEach, describe, expect, it } from "vitest";
import { createDesk } from "../src/desk/index.ts";
import { DockerDesk } from "../src/desk/docker.ts";
import { FakeDesk } from "../src/desk/fake.ts";

const KEYS = ["COMPUTER_DESK", "COMPUTER_DESK_CONTAINER"] as const;
const saved = new Map<string, string | undefined>();

function setMode(env: Record<string, string | undefined>): void {
  for (const k of KEYS) {
    if (!saved.has(k)) saved.set(k, process.env[k]);
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  saved.clear();
});

describe("createDesk", () => {
  it("defaults to the fake desk", () => {
    setMode({ COMPUTER_DESK: undefined });
    expect(createDesk(1)).toBeInstanceOf(FakeDesk);
  });

  it("uses docker exec against the compose desk container", () => {
    setMode({ COMPUTER_DESK: "docker", COMPUTER_DESK_CONTAINER: "computer-desk" });
    const desk = createDesk(2);
    expect(desk).toBeInstanceOf(DockerDesk);
    expect((desk as DockerDesk).display).toBe(2);
  });

  it("uses the in-guest transport on a Fly Machine", () => {
    setMode({ COMPUTER_DESK: "local" });
    const desk = createDesk(1);
    expect(desk).toBeInstanceOf(DockerDesk);
    expect((desk as DockerDesk).display).toBe(1);
  });
});
