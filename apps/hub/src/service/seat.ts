import { ComputerError, type SeatState } from "@computer/shared";

/**
 * One box, one seat.
 *
 *   AGENT ──request_takeover──► WAITING ──I'm done──► AGENT
 *     ▲                           │
 *     │                           └── pointer/clipboard ──┐
 *     │                                                   ▼
 *     └────────── I'm done ────────────────────────────  HUMAN
 *                                                         ▲
 *                        SetPresence(true) ───────────────┘
 *
 * The agent asks for a human with request_takeover, but a human never has
 * to wait to be asked: SetPresence(true) takes the seat from AGENT. The
 * agent's next call then gets SEAT_HELD, which it already knows how to
 * wait on — the person watching a machine work is the one who can see it
 * going wrong, and telling them to wait for permission to grab the wheel
 * is the wrong way round.
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

  /**
   * Seat.SetPresence: true takes the seat, false is I'm done.
   * Taking works from AGENT too — that is a human interrupting, not a
   * protocol violation.
   */
  setPresence(present: boolean): SeatState {
    this.state = present ? "HUMAN" : "AGENT";
    return this.state;
  }

  /** Test helper */
  reset(state: SeatState = "AGENT"): void {
    this.state = state;
  }
}
