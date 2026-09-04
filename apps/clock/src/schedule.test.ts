import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { validCron } from "@computer/shared";
import { dueSoon, nextDue, readSchedule } from "./schedule.ts";
import type { BotRoutines } from "./schedule.ts";

const BOTS_ROOT = resolve(import.meta.dirname, "../../eve/bots");
const at = (iso: string): number => Date.parse(iso);

const brief: BotRoutines[] = [
  { botId: "chief-of-staff", routines: [{ cron: "0 20 * * 0-4", id: "morning-brief" }] },
  { botId: "qa", routines: [{ cron: "0 2,14 * * *", id: "prod-smoke" }] },
];

test("the schedule is the Bots' own routine manifests", () => {
  const schedule = readSchedule(BOTS_ROOT);
  assert.ok(schedule.length > 0, "no Bot in apps/eve/bots declares a routine");
  for (const bot of schedule) {
    for (const routine of bot.routines) {
      assert.ok(validCron(routine.cron), `${bot.botId}/${routine.id}: ${routine.cron}`);
    }
  }
});

test("a tree with no Bots is no schedule, not a crash", () => {
  assert.deepEqual(readSchedule(resolve(BOTS_ROOT, "no-such-tree")), []);
});

test("a routine is due within the lead time, and not before it", () => {
  // 19:58 with three minutes of lead reaches 20:01, so the 20:00 brief is due.
  const due = dueSoon(brief, at("2026-09-06T19:58:00Z"), 3 * 60_000);
  assert.deepEqual(
    due.map((d) => `${d.botId}/${d.routineId}`),
    ["chief-of-staff/morning-brief"],
  );
  assert.equal(due[0]?.atMs, at("2026-09-06T20:00:00Z"));
  assert.deepEqual(dueSoon(brief, at("2026-09-06T19:50:00Z"), 3 * 60_000), []);
});

test("the minute a routine fires in still counts as due", () => {
  // A tick that lands after the minute has lost the wake; waking late is
  // worth more than not waking at all.
  const due = dueSoon(brief, at("2026-09-06T20:00:31Z"), 0);
  assert.equal(due.length, 1);
  assert.equal(due[0]?.atMs, at("2026-09-06T20:00:00Z"));
});

test("a routine that does not run today is not due", () => {
  // 0-4 is Sunday to Thursday: the 10th is a Thursday and the 11th a Friday,
  // and nothing else fires at that hour.
  assert.equal(dueSoon(brief, at("2026-09-10T19:58:00Z"), 3 * 60_000).length, 1);
  assert.deepEqual(dueSoon(brief, at("2026-09-11T19:58:00Z"), 3 * 60_000), []);
});

test("a manifest that cannot be used says so, rather than skipping quietly", () => {
  const root = mkdtempSync(join(tmpdir(), "clock-bots-"));
  try {
    mkdirSync(join(root, "broken", "agent"), { recursive: true });
    writeFileSync(join(root, "broken", "agent", "routines.json"), "{ not json");
    mkdirSync(join(root, "quiet", "agent"), { recursive: true });
    const warnings: string[] = [];
    assert.deepEqual(
      readSchedule(root, (line) => warnings.push(line)),
      [],
    );
    // A Bot with no manifest is the normal case. A Bot with one the clock
    // cannot read is a routine nothing will ever be woken for, which is the
    // failure this whole app exists to stop being silent.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /broken/u);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("every manifest this build ships parses", () => {
  const warnings: string[] = [];
  readSchedule(BOTS_ROOT, (line) => warnings.push(line));
  assert.deepEqual(warnings, []);
});

test("the next firing of every routine, soonest first", () => {
  const next = nextDue(brief, at("2026-09-06T12:00:00Z"));
  assert.deepEqual(
    next.map((d) => `${d.botId}/${d.routineId} ${new Date(d.atMs).toISOString()}`),
    [
      "qa/prod-smoke 2026-09-06T14:00:00.000Z",
      "chief-of-staff/morning-brief 2026-09-06T20:00:00.000Z",
    ],
  );
});
