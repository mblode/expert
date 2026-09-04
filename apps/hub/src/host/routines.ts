import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 */
interface Routine {
  id: string;
  /** Standard 5-field cron, UTC, as the schedule file has it. */
  cron: string;
}

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
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`bot ${botId}: routines.json is not valid JSON; its routines will not wake it`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(
    (r): r is Routine =>
      typeof r === "object" &&
      r !== null &&
      typeof (r as Routine).id === "string" &&
      typeof (r as Routine).cron === "string" &&
      validCron((r as Routine).cron),
  );
}

/**
 * Does this cron fire in the minute containing `at`?
 *
 * Five fields, UTC, and the subset of the syntax the schedules here use:
 * a star, a number, `a-b`, `a,b`, and a step written star-slash-n.
 * Anything else is refused by
 * `validCron` on the way in rather than guessed at, because a cron this does
 * not understand would silently never wake its Bot. Day-of-month and
 * day-of-week are OR'd when both are restricted, which is the standard rule.
 */
export function cronMatches(cron: string, at: Date): boolean {
  const f = cron.trim().split(/\s+/u);
  if (f.length !== 5) {
    return false;
  }
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string];
  if (!(matches(minute, at.getUTCMinutes()) && matches(hour, at.getUTCHours()))) {
    return false;
  }
  if (!matches(month, at.getUTCMonth() + 1)) {
    return false;
  }
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const domHit = matches(dom, at.getUTCDate());
  // Sunday is 0 and 7 in cron; `getUTCDay()` only ever says 0.
  const dowHit = matches(dow, at.getUTCDay()) || matches(dow, at.getUTCDay() + 7);
  if (domRestricted && dowRestricted) {
    return domHit || dowHit;
  }
  return domHit && dowHit;
}

export function validCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/u);
  return f.length === 5 && f.every((field) => FIELD.test(field));
}

const FIELD = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/u;

function matches(field: string, value: number): boolean {
  return field.split(",").some((part) => matchesPart(part, value));
}

function matchesPart(part: string, value: number): boolean {
  const [range, stepRaw] = part.split("/");
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1) {
    return false;
  }
  if (range === "*") {
    return value % step === 0;
  }
  const [fromRaw, toRaw] = (range ?? "").split("-");
  const from = Number(fromRaw);
  const to = toRaw === undefined ? from : Number(toRaw);
  if (!(Number.isInteger(from) && Number.isInteger(to))) {
    return false;
  }
  return value >= from && value <= to && (value - from) % step === 0;
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
