import { ComputerError, type SeatState } from "@computer/shared";

/**
 * One box, one seat.
 *
 *   AGENT ──request_takeover──► WAITING ──I'm done──► AGENT
 *                                 │
 *                                 └── pointer/clipboard ──► HUMAN ──I'm done──► AGENT
 */
export class SeatService {
  private state: SeatState = "AGENT";

  getState(): SeatState {
    return this.state;
  }

  /** computer.request_takeover */
  requestTakeover(): SeatState {
    if (this.state !== "AGENT") {
      throw new ComputerError("SEAT_HELD", "human has the seat");
    }
    this.state = "WAITING";
    return this.state;
  }

  /** Agent.Computer / Shell / files — only when AGENT */
  requireAgent(): void {
    if (this.state !== "AGENT") {
      throw new ComputerError("SEAT_HELD", "human has the seat");
    }
  }

  /**
   * First human contact (pointer, type, clipboard) while WAITING → HUMAN.
   * While AGENT, human pointer is rejected.
   */
  requireHumanContact(): void {
    if (this.state === "AGENT") {
      throw new ComputerError("SEAT_HELD", "agent has the seat");
    }
    if (this.state === "WAITING") {
      this.state = "HUMAN";
    }
  }

  /** Seat.SetPresence({ present: false }) is I'm done. */
  setPresence(present: boolean): SeatState {
    if (present) {
      if (this.state === "WAITING") this.state = "HUMAN";
      return this.state;
    }
    this.state = "AGENT";
    return this.state;
  }

  /** Test helper */
  reset(state: SeatState = "AGENT"): void {
    this.state = state;
  }
}
