import { describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import { SeatService } from "../src/service/seat.ts";

describe("SeatService FSM", () => {
  it("starts AGENT; takeover → WAITING; first contact → HUMAN; I'm done → AGENT", () => {
    const s = new SeatService();
    expect(s.getState()).toBe("AGENT");
    expect(s.requestTakeover()).toBe("WAITING");
    s.requireHumanContact();
    expect(s.getState()).toBe("HUMAN");
    expect(s.setPresence(false)).toBe("AGENT");
  });

  it("WAITING + I'm done skips HUMAN and returns AGENT", () => {
    const s = new SeatService();
    s.requestTakeover();
    expect(s.setPresence(false)).toBe("AGENT");
  });

  it("rejects computer while WAITING or HUMAN", () => {
    const s = new SeatService();
    s.requestTakeover();
    expect(() => s.requireAgent()).toThrow(ComputerError);
    s.requireHumanContact();
    expect(() => s.requireAgent()).toThrowError(/human has the seat/);
  });

  it("rejects human pointer while AGENT", () => {
    const s = new SeatService();
    expect(() => s.requireHumanContact()).toThrowError(/agent has the seat/);
  });

  it("takeover while not AGENT is SEAT_HELD", () => {
    const s = new SeatService();
    s.requestTakeover();
    expect(() => s.requestTakeover()).toThrow(ComputerError);
  });
});
