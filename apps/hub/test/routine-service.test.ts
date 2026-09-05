import { expect, it } from "vitest";
import { localMinute, nextRoutine, RoutineService } from "../src/service/routines.ts";
import type { ClockClient } from "../src/service/clock.ts";

it("resolves local schedules across the Melbourne DST jump", () => {
  const at = Date.parse("2026-10-03T15:00:00Z");
  const next = nextRoutine("0 3 * * *", "Australia/Melbourne", at);
  expect(new Date(next).toISOString()).toBe("2026-10-03T16:00:00.000Z");
  expect(localMinute(next, "Australia/Melbourne")).toBe("2026-10-04T03:00");
  expect(() => nextRoutine("bad", "Australia/Melbourne", at)).toThrow();
});

it("serialises revision changes and pauses future wakes", async () => {
  const clock = { checkAt: async () => {}, hold: async () => {} } as unknown as ClockClient;
  const service = new RoutineService({
    clock,
    run: async () => {},
    notify: async () => {},
    now: () => Date.parse("2026-09-05T00:00:00Z"),
  });
  await service.configure("main", {
    operation: "save",
    id: "morning",
    base_revision: 0,
    prompt: "Summarise my tasks",
    cron: "0 9 * * *",
    timezone: "Australia/Melbourne",
  });
  await expect(
    service.configure("main", { operation: "pause", id: "morning", base_revision: 0 }),
  ).rejects.toThrow();
  const paused = await service.configure("main", {
    operation: "pause",
    id: "morning",
    base_revision: 1,
  });
  expect(paused[0]?.enabled).toBe(false);
  expect(paused[0]?.pending).toBe(false);
  expect(service.list("another-bot")).toEqual([]);
});
