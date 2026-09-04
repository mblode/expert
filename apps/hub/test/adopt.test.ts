import { describe, expect, it, vi } from "vitest";
import { watchRoster } from "../src/host/adopt.ts";
import type { BotConfig } from "../src/service/bots.ts";

const bot = (id: string, display: number): BotConfig => ({ display, id, token: `t-${id}` });

describe("a Bot made while the computer is running", () => {
  it("is adopted once, and the ones from boot are not", () => {
    vi.useFakeTimers();
    let roster = [bot("main", 1), bot("qa", 2)];
    const adopted: string[] = [];
    const stop = watchRoster({
      onAdopt: (b) => adopted.push(b.id),
      read: () => roster,
      seen: ["main", "qa"],
    });
    expect(adopted).toEqual([]);

    roster = [...roster, bot("night", 3)];
    vi.advanceTimersByTime(1000);
    expect(adopted).toEqual(["night"]);

    // Still there on the next read: adopting twice would register a second
    // child under the same id.
    vi.advanceTimersByTime(3000);
    expect(adopted).toEqual(["night"]);
    stop();
    vi.useRealTimers();
  });

  it("keeps trying a Bot whose child could not be registered", () => {
    vi.useFakeTimers();
    const roster = [bot("main", 1), bot("night", 2)];
    let failing = true;
    const tries: string[] = [];
    const events: string[] = [];
    const stop = watchRoster({
      onAdopt: (b) => {
        tries.push(b.id);
        if (failing) {
          throw new Error("supervisor said no");
        }
      },
      onEvent: (line) => events.push(line),
      read: () => roster,
      seen: ["main"],
    });
    expect(tries).toEqual(["night"]);
    expect(events[0]).toContain("supervisor said no");

    failing = false;
    vi.advanceTimersByTime(1000);
    // Tried again after the failure, and not again once it worked.
    expect(tries).toEqual(["night", "night"]);
    vi.advanceTimersByTime(3000);
    expect(tries).toEqual(["night", "night"]);
    stop();
    vi.useRealTimers();
  });

  it("survives a roster it cannot read, because this runs inside PID 1", () => {
    vi.useFakeTimers();
    let broken = true;
    const adopted: string[] = [];
    const events: string[] = [];
    const stop = watchRoster({
      onAdopt: (b) => adopted.push(b.id),
      onEvent: (line) => events.push(line),
      read: () => {
        if (broken) {
          throw new Error("EACCES");
        }
        return [bot("night", 2)];
      },
      seen: [],
    });
    expect(events[0]).toContain("EACCES");

    broken = false;
    vi.advanceTimersByTime(1000);
    expect(adopted).toEqual(["night"]);
    stop();
    vi.useRealTimers();
  });
});
