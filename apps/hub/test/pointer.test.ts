import { describe, expect, it } from "vitest";
import { FakeDesk } from "../src/desk/fake.ts";
import { SeatService } from "../src/service/seat.ts";

describe("pointer deltas stay in 1280×800", () => {
  it("clamps and supports grab for trackpad drag", async () => {
    const d = new FakeDesk();
    await d.pointerDelta(10_000, -10_000);
    expect(d.getCursor()).toEqual({ x: 1279, y: 0 });
    await d.pointerDelta(-1, 1, true);
    expect(d.grabs).toBe(1);
    expect(d.getCursor()).toEqual({ x: 1278, y: 1 });
  });

  it("Type is seat-only unicode, not a model tool", async () => {
    const seat = new SeatService();
    expect(() => seat.requireHumanContact()).toThrow();
    seat.requestTakeover();
    seat.requireHumanContact();
    const d = new FakeDesk();
    await d.type("你好");
    expect(d.lastType).toBe("你好");
  });
});
