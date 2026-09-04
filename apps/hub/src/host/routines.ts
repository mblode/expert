import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cronMatches, parseRoutines } from "@computer/shared";
import type { Routine } from "@computer/shared";

/**
 * The alarm clock for Bots that are asleep.
 *
 * A Bot's routines are compiled into its own Eve (`agent/schedules/*.ts`,
 * croner in the bundle), which fires them only while that process is running.
 * Sleeping Bots would therefore quietly stop running their routines, which is
 * the worst kind of regression: nothing fails, the morning brief simply never
 * comes. So each Bot also declares its schedule as data, the hub reads it, and
 * a minute before a cron is due it writes that Bot's wake marker. The process
 * is up in time and fires the routine itself; the hub never runs one.
 *
 * Two files saying the same thing is a real cost, and `routines.test.ts` in
 * the hub pins them together: every `defineSchedule({ cron })` in a Bot's
 * project must appear in its `agent/routines.json`, and the other way round.
 *
 * This is the inner of two alarms, and it only runs while the Machine does. A
 * guest that has suspended to zero has no clock at all, so the outer one is
 * `apps/clock`: an always-on Fly app that wakes the Machine through Fly Proxy
 * a few minutes before any routine minute, which is what puts this file back
 * on the clock in time to wake the Bot. The cron itself is
 * `packages/shared` so that both alarms answer "is it due?" identically.
 */

/** A Bot's declared routines, or none when it has no `routines.json`. */
export function readRoutines(
  botsRoot: string,
  botId: string,
  read: (path: string) => string = (p) => readFileSync(p, "utf-8"),
): Routine[] {
  let raw: string;
  try {
    raw = read(join(botsRoot, botId, "agent", "routines.json"));
  } catch {
    return [];
  }
  const routines = parseRoutines(raw);
  if (routines.length === 0 && raw.trim() !== "[]") {
    console.warn(`bot ${botId}: no usable routines.json; its routines will not wake it`);
  }
  return routines;
}

interface AlarmOptions {
  /** Bots that can be asleep, with the routines they declared. */
  bots: readonly { botId: string; routines: readonly Routine[] }[];
  /** Keep this Bot awake until the given time. */
  keepAwake: (botId: string, untilMs: number) => void;
  /**
   * How long a woken Bot stays up for its routine. Long enough for the turn
   * it is about to run; its own tool calls extend it from there.
   */
  awakeMs?: number;
  /** How far ahead a due routine is noticed. One minute, so the Eve is up. */
  leadMs?: number;
  tickMs?: number;
  now?: () => number;
  onEvent?: (line: string) => void;
}

const DEFAULT_AWAKE_MS = 30 * 60 * 1000;
const DEFAULT_LEAD_MS = 60_000;
const DEFAULT_TICK_MS = 30_000;

/**
 * Watch the clock and wake Bots before their routines are due. Returns the
 * stop function.
 */
export function routineAlarm(opts: AlarmOptions): () => void {
  const now = opts.now ?? Date.now;
  const awakeMs = opts.awakeMs ?? DEFAULT_AWAKE_MS;
  const leadMs = opts.leadMs ?? DEFAULT_LEAD_MS;
  const fired = new Set<string>();
  const tick = (): void => {
    const at = now();
    const due = new Date(at + leadMs);
    // One key per Bot, routine and minute: a 30s tick sees the same minute
    // twice, and waking twice would rewrite the marker for nothing.
    const minute = `${due.getUTCFullYear()}-${due.getUTCMonth()}-${due.getUTCDate()}T${due.getUTCHours()}:${due.getUTCMinutes()}`;
    for (const bot of opts.bots) {
      for (const routine of bot.routines) {
        const key = `${bot.botId}:${routine.id}:${minute}`;
        if (fired.has(key) || !cronMatches(routine.cron, due)) {
          continue;
        }
        fired.add(key);
        opts.keepAwake(bot.botId, at + awakeMs);
        opts.onEvent?.(`routine ${routine.id} is due: waking ${bot.botId}`);
      }
    }
    // The set only ever holds the last few minutes of keys.
    if (fired.size > 64) {
      fired.clear();
    }
  };
  tick();
  const timer = setInterval(tick, opts.tickMs ?? DEFAULT_TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
