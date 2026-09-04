import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_DISPLAYS } from "@computer/shared";
import { describe, expect, it } from "vitest";

/**
 * The screen ceiling exists twice: `MAX_DISPLAYS` for everything in
 * TypeScript, and a literal in the desk's bash, which cannot import it.
 *
 * This test is the only thing keeping the two honest, and it is here because
 * they were not. `MAX_DISPLAYS` went to 16 so `Seat.CreateBot` could hand out
 * a ninth screen; the desk scripts stayed at 8, so the hub allocated screen 9,
 * wrote the roster row, and `start-window` refused it with "window index must
 * be 1..8". Making a Bot failed on a box with seven screens free, and nothing
 * in CI noticed, because the number that broke was in a shell script.
 */
const DESK_BIN = resolve(import.meta.dirname, "../../desk/bin");

const read = (name: string): string => readFileSync(resolve(DESK_BIN, name), "utf-8");

describe("the desk's screen ceiling", () => {
  it.each(["start-window", "stop-window"])("%s bounds the index at MAX_DISPLAYS", (script) => {
    const source = read(script);
    const declared = /^MAX_WINDOWS=(\d+)$/mu.exec(source)?.[1];
    expect(declared).toBe(String(MAX_DISPLAYS));
    // The guard has to use the variable, not a second copy of the number.
    expect(source).toContain("N > MAX_WINDOWS");
    expect(source).toContain('echo "window index must be 1..$MAX_WINDOWS"');
  });

  it("the shutdown sweep covers every screen that could be claimed", () => {
    // A window above the ceiling cannot exist; one below a stale bound would be
    // left running, holding Chromium's profile lock on the volume.
    const swept = /seq (\d+) -1 1/u.exec(read("entrypoint.sh"))?.[1];
    expect(swept).toBe(String(MAX_DISPLAYS));
  });
});
