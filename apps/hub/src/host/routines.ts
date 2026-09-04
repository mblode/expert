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
 *
 * What this does not fix: a Machine that suspends to zero has no clock, so a
 * routine whose minute passes while the guest is suspended does not fire here
 * either, and nothing catches it up afterwards. Closing that needs something
 * outside the box (a pinger, or a Machine that stays running), and pretending
 * otherwise in this file would be the same silent failure one level up.
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
  if (
    !(matches(minute, at.getUTCMinutes(), BOUNDS[0]) && matches(hour, at.getUTCHours(), BOUNDS[1]))
  ) {
    return false;
  }
  if (!matches(month, at.getUTCMonth() + 1, BOUNDS[3])) {
    return false;
  }
  const domRestricted = dom !== "*";
  const dowRestricted = dow !== "*";
  const domHit = matches(dom, at.getUTCDate(), BOUNDS[2]);
  // Sunday is 0 and 7 in cron and `getUTCDay()` only ever says 0, so a field
  // written as `7` still has to match. A step is not tried at 7: counting
  // from the field minimum already covers Sunday at 0.
  const dowHit =
    matches(dow, at.getUTCDay(), BOUNDS[4]) ||
    (at.getUTCDay() === 0 && matches(dow.replaceAll(/\/\d+/gu, ""), 7, BOUNDS[4]));
  if (domRestricted && dowRestricted) {
    return domHit || dowHit;
  }
  return domHit && dowHit;
}

/**
 * Every field's own bounds, in cron's order. A step counts from the field's
 * minimum, not from zero, which is why they are here: a step of two in
 * day-of-month is the 1st, 3rd and 5th, and reading it as "even days" would
 * fire a routine on the wrong days for the life of the box. Day-of-week
 * allows 7 for Sunday.
 */
const BOUNDS = [
  { max: 59, min: 0 },
  { max: 23, min: 0 },
  { max: 31, min: 1 },
  { max: 12, min: 1 },
  { max: 7, min: 0 },
] as const;

/**
 * A cron this file can actually evaluate: five fields, each in range.
 *
 * Range-checked rather than shape-checked, because an unmatchable field
 * (minute 99) is a routine that never wakes its Bot and says nothing, which
 * is the exact thing this module exists to prevent.
 */
export function validCron(cron: string): boolean {
  const f = cron.trim().split(/\s+/u);
  if (f.length !== 5) {
    return false;
  }
  return f.every((field, i) => fieldValid(field, BOUNDS[i]!));
}

const FIELD = /^(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?)(,(\*(\/\d+)?|\d+(-\d+)?(\/\d+)?))*$/u;

interface Bound {
  min: number;
  max: number;
}

function fieldValid(field: string, bound: Bound): boolean {
  if (!FIELD.test(field)) {
    return false;
  }
  return field.split(",").every((part) => partValid(part, bound));
}

function partValid(part: string, bound: Bound): boolean {
  const [range, stepRaw] = part.split("/");
  if (stepRaw !== undefined && !(Number(stepRaw) >= 1)) {
    return false;
  }
  if (range === "*") {
    return true;
  }
  const [fromRaw, toRaw] = (range ?? "").split("-");
  const from = Number(fromRaw);
  const to = toRaw === undefined ? from : Number(toRaw);
  return from >= bound.min && from <= bound.max && to >= from && to <= bound.max;
}

function matches(field: string, value: number, bound: Bound): boolean {
  return field.split(",").some((part) => matchesPart(part, value, bound));
}

function matchesPart(part: string, value: number, bound: Bound): boolean {
  const [range, stepRaw] = part.split("/");
  const step = stepRaw === undefined ? 1 : Number(stepRaw);
  if (!Number.isInteger(step) || step < 1) {
    return false;
  }
  if (range === "*") {
    return value >= bound.min && value <= bound.max && (value - bound.min) % step === 0;
  }
  const [fromRaw, toRaw] = (range ?? "").split("-");
  const from = Number(fromRaw);
  const to = toRaw === undefined && stepRaw === undefined ? from : Number(toRaw ?? bound.max);
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
