import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cronMatches, parseRoutines } from "@computer/shared";
import type { Routine } from "@computer/shared";

/**
 * What the clock knows about the box: when, in UTC, some Bot on it has
 * something to do.
 *
 * It reads the Bots' own `agent/routines.json`, the same files the hub reads
 * on the guest, from the same repo the guest image is built from. The clock
 * deliberately never asks a tenant for its schedule: asking would mean an
 * HTTP request, an HTTP request through Fly Proxy starts the Machine, and a
 * clock that has to wake the box to find out when to wake the box is a
 * Machine that never suspends. The cost is that a routine added to a Bot
 * reaches the clock only when the clock is deployed too, which is why
 * `docs/DEPLOY.md` deploys them together and why `/healthz` here prints the
 * schedule it is actually running.
 */
export interface BotRoutines {
  botId: string;
  routines: Routine[];
}

interface DueRoutine {
  botId: string;
  routineId: string;
  /** The UTC minute it fires, as epoch milliseconds. */
  atMs: number;
}

/**
 * Every Bot's declared routines, read from a `apps/eve/bots`-shaped tree.
 *
 * A Bot with no manifest is the normal case and is passed over in silence. A
 * Bot with a manifest this cannot use is not: that is a routine nothing will
 * ever be woken for, and it would otherwise look exactly like a Bot that has
 * none.
 */
export function readSchedule(
  botsRoot: string,
  warn: (line: string) => void = () => undefined,
): BotRoutines[] {
  let entries: string[];
  try {
    entries = readdirSync(botsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .toSorted();
  } catch {
    return [];
  }
  const schedule: BotRoutines[] = [];
  for (const botId of entries) {
    let raw: string;
    try {
      raw = readFileSync(join(botsRoot, botId, "agent", "routines.json"), "utf-8");
    } catch {
      // A Bot with no routines is the normal case, not an error.
      continue;
    }
    const routines = parseRoutines(raw);
    if (routines.length > 0) {
      schedule.push({ botId, routines });
    } else if (raw.trim() !== "[]") {
      warn(
        `clock: ${botId}/agent/routines.json has no routine this can read; it will wake nothing`,
      );
    }
  }
  return schedule;
}

const MINUTE_MS = 60_000;

/**
 * The routines firing between now and `withinMs` from now.
 *
 * The minute containing `at` counts as due. A tick that arrives thirty
 * seconds after the minute has already lost the wake, and waking late is
 * worth more than not waking: the box's own alarm still has the marker to
 * write, and a routine that runs a minute late ran.
 */
export function dueSoon(
  schedule: readonly BotRoutines[],
  at: number,
  withinMs: number,
): DueRoutine[] {
  const due: DueRoutine[] = [];
  const first = Math.floor(at / MINUTE_MS) * MINUTE_MS;
  for (let m = first; m <= at + withinMs; m += MINUTE_MS) {
    const when = new Date(m);
    for (const bot of schedule) {
      for (const routine of bot.routines) {
        if (cronMatches(routine.cron, when)) {
          due.push({ atMs: m, botId: bot.botId, routineId: routine.id });
        }
      }
    }
  }
  return due;
}

/** How far ahead `nextDue` will look before answering "nothing". */
const HORIZON_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * The next firing of every routine, for the clock's own `/healthz`.
 *
 * A minute-by-minute scan over a week, which is thousands of cheap integer
 * comparisons and only ever runs when a person asks. Worth it: the failure
 * this whole app exists to prevent is silent, so being able to read what the
 * clock thinks it is waiting for is most of the way to noticing it is wrong.
 */
export function nextDue(schedule: readonly BotRoutines[], from: number): DueRoutine[] {
  const pending = new Map<string, DueRoutine>();
  const total = schedule.reduce((n, bot) => n + bot.routines.length, 0);
  const first = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  for (let m = first; m < from + HORIZON_MS && pending.size < total; m += MINUTE_MS) {
    const when = new Date(m);
    for (const bot of schedule) {
      for (const routine of bot.routines) {
        const key = `${bot.botId}:${routine.id}`;
        if (!pending.has(key) && cronMatches(routine.cron, when)) {
          pending.set(key, { atMs: m, botId: bot.botId, routineId: routine.id });
        }
      }
    }
  }
  return [...pending.values()].toSorted((a, b) => a.atMs - b.atMs);
}
