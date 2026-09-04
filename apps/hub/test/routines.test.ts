import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { cronMatches, validCron } from "@computer/shared";
import { describe, expect, it } from "vitest";
import { readRoutines, routineAlarm } from "../src/host/routines.ts";

const BOTS_ROOT = resolve(import.meta.dirname, "../../eve/bots");

const utc = (iso: string): Date => new Date(iso);

describe("cron, the subset the schedules use", () => {
  it("matches a plain minute and hour", () => {
    expect(cronMatches("0 20 * * *", utc("2026-09-04T20:00:00Z"))).toBe(true);
    expect(cronMatches("0 20 * * *", utc("2026-09-04T20:01:00Z"))).toBe(false);
    expect(cronMatches("0 20 * * *", utc("2026-09-04T19:00:00Z"))).toBe(false);
  });

  it("matches a list and a range of days", () => {
    // 0-4 is Sunday to Thursday UTC, which is the weekday morning in Melbourne.
    expect(cronMatches("0 20 * * 0-4", utc("2026-09-06T20:00:00Z"))).toBe(true); // Sunday
    expect(cronMatches("0 20 * * 0-4", utc("2026-09-10T20:00:00Z"))).toBe(true); // Thursday
    expect(cronMatches("0 20 * * 0-4", utc("2026-09-11T20:00:00Z"))).toBe(false); // Friday
    expect(cronMatches("0 2,14 * * *", utc("2026-09-04T14:00:00Z"))).toBe(true);
    expect(cronMatches("0 2,14 * * *", utc("2026-09-04T13:00:00Z"))).toBe(false);
  });

  it("matches a step and a single weekday", () => {
    expect(cronMatches("0 */4 * * *", utc("2026-09-04T08:00:00Z"))).toBe(true);
    expect(cronMatches("0 */4 * * *", utc("2026-09-04T09:00:00Z"))).toBe(false);
    expect(cronMatches("0 21 * * 6", utc("2026-09-05T21:00:00Z"))).toBe(true); // Saturday
    expect(cronMatches("0 21 * * 6", utc("2026-09-06T21:00:00Z"))).toBe(false);
  });

  it("refuses what it does not understand rather than guessing", () => {
    expect(validCron("0 20 * *")).toBe(false);
    expect(validCron("@daily")).toBe(false);
    expect(validCron("0 20 * * MON")).toBe(false);
    expect(cronMatches("@daily", utc("2026-09-04T20:00:00Z"))).toBe(false);
  });
});

describe("the alarm wakes a Bot before its routine", () => {
  it("wakes once per due minute, a minute ahead", () => {
    const woke: { botId: string; until: number }[] = [];
    let now = Date.parse("2026-09-04T19:58:30Z");
    const stop = routineAlarm({
      awakeMs: 1000,
      bots: [{ botId: "chief-of-staff", routines: [{ cron: "0 20 * * *", id: "morning-brief" }] }],
      keepAwake: (botId, until) => woke.push({ botId, until }),
      now: () => now,
      tickMs: 60_000,
    });
    expect(woke).toEqual([]);

    // 19:59:00 plus a minute of lead is 20:00, which is when it fires.
    now = Date.parse("2026-09-04T19:59:00Z");
    stop();
    const woke2: { botId: string; until: number }[] = [];
    const stop2 = routineAlarm({
      awakeMs: 1000,
      bots: [{ botId: "chief-of-staff", routines: [{ cron: "0 20 * * *", id: "morning-brief" }] }],
      keepAwake: (botId, until) => woke2.push({ botId, until }),
      now: () => now,
      tickMs: 60_000,
    });
    expect(woke2).toEqual([{ botId: "chief-of-staff", until: now + 1000 }]);
    stop2();
  });
});

/**
 * The schedule is written twice on purpose: the Bot's Eve owns the routine
 * and the hub only needs to know when to have that process running. Two
 * copies drift, so this is the thing that stops them.
 */
describe("every routine a Bot ships is declared where the hub can read it", () => {
  const bots = readdirSync(BOTS_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  it.each(bots)("%s: routines.json matches agent/schedules", (bot) => {
    const dir = join(BOTS_ROOT, bot, "agent", "schedules");
    const scheduled = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => f.endsWith(".ts"))
          .map((f) => {
            const cron = /cron:\s*"([^"]+)"/u.exec(readFileSync(join(dir, f), "utf-8"))?.[1];
            return { cron, id: f.replace(/\.ts$/u, "") };
          })
      : [];
    const declared = readRoutines(BOTS_ROOT, bot);
    expect(
      declared.toSorted((a, b) => a.id.localeCompare(b.id)),
      `${bot}: agent/routines.json is how a sleeping Bot gets woken for these`,
    ).toEqual(scheduled.toSorted((a, b) => a.id.localeCompare(b.id)));
  });
});

describe("cron fields are checked against their own bounds", () => {
  it("refuses a value no clock can produce", () => {
    expect(validCron("99 20 * * *")).toBe(false);
    expect(validCron("0 25 * * *")).toBe(false);
    expect(validCron("0 20 32 * *")).toBe(false);
    expect(validCron("0 20 * 13 *")).toBe(false);
    expect(validCron("0 20 * * 8")).toBe(false);
    expect(validCron("0 20 * * */0")).toBe(false);
    expect(validCron("0 20 0 * *")).toBe(false);
  });

  it("counts a step from the field's own minimum", () => {
    // Day-of-month starts at 1, so a step of two is the 1st, 3rd, 5th.
    expect(cronMatches("0 20 */2 * *", utc("2026-09-01T20:00:00Z"))).toBe(true);
    expect(cronMatches("0 20 */2 * *", utc("2026-09-02T20:00:00Z"))).toBe(false);
    expect(cronMatches("0 20 */2 * *", utc("2026-09-03T20:00:00Z"))).toBe(true);
    // Minutes start at 0, so a step of two is the even ones.
    expect(cronMatches("*/2 20 * * *", utc("2026-09-01T20:00:00Z"))).toBe(true);
    expect(cronMatches("*/2 20 * * *", utc("2026-09-01T20:01:00Z"))).toBe(false);
  });

  it("takes 7 as Sunday", () => {
    expect(cronMatches("0 20 * * 7", utc("2026-09-06T20:00:00Z"))).toBe(true); // Sunday
    expect(cronMatches("0 20 * * 7", utc("2026-09-07T20:00:00Z"))).toBe(false);
  });

  it("keeps a range with a step inside the range", () => {
    expect(cronMatches("0 8-18/4 * * *", utc("2026-09-04T08:00:00Z"))).toBe(true);
    expect(cronMatches("0 8-18/4 * * *", utc("2026-09-04T12:00:00Z"))).toBe(true);
    expect(cronMatches("0 8-18/4 * * *", utc("2026-09-04T20:00:00Z"))).toBe(false);
  });
});
