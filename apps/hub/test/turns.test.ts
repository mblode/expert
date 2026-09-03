import { describe, expect, it } from "vitest";
import { ComputerError } from "@computer/shared";
import { TurnService } from "../src/service/turns.ts";

describe("turn tokens", () => {
  it("mints a token bound to a conversation and a Bot", () => {
    const turns = new TurnService();
    const turn = turns.mint({ bot: "main", conversation_id: "conv_a" });
    expect(turn.id).toMatch(/^turn_[A-Za-z0-9_-]+$/);
    expect(turn.conversation_id).toBe("conv_a");
    expect(turn.bot).toBe("main");
    // The hop budget rides the token so bot-to-bot needs no second mechanism.
    expect(turn.hops_left).toBe(3);
    expect(turn.deadline_at).toBeGreaterThan(Date.now());
    expect(turns.verify(turn.id, "main")).toEqual(turn);
    // Two mints are two tokens, so a leaked one is one turn's worth of reach.
    expect(turns.mint({ bot: "main", conversation_id: "conv_a" }).id).not.toBe(turn.id);
  });

  it("refuses a token it did not mint", () => {
    const turns = new TurnService();
    // Not a guessable id and not one from another hub: unknown is unknown.
    expect(() => turns.verify("turn_made-up", "main")).toThrow(ComputerError);
    expect(() => turns.verify("turn_made-up", "main")).toThrow(/unknown turn/);
    try {
      turns.verify("", "main");
    } catch (error) {
      expect((error as ComputerError).code).toBe("UNAUTHENTICATED");
    }
  });

  it("refuses a token past its deadline, and forgets it", () => {
    const turns = new TurnService(0);
    const turn = turns.mint({ bot: "main", conversation_id: "conv_a" });
    // A zero TTL is already past: a send after the turn is over cannot land
    // in it, and the reply it was minted for is long gone.
    let code: string | undefined;
    try {
      turns.verify(turn.id, "main");
    } catch (error) {
      ({ code } = error as ComputerError);
      expect((error as Error).message).toMatch(/expired/);
    }
    expect(code).toBe("UNAUTHENTICATED");
    // Refused once, then unknown: the map does not grow with dead turns.
    expect(() => turns.verify(turn.id, "main")).toThrow(/unknown turn/);
  });

  it("refuses a real token presented by another Bot", () => {
    const turns = new TurnService();
    const turn = turns.mint({ bot: "main", conversation_id: "conv_a" });
    // Bots are not security boundaries on the box, but attribution is the
    // whole point of the record: `night` must not speak in main's voice.
    try {
      turns.verify(turn.id, "night");
      expect.unreachable();
    } catch (error) {
      expect((error as ComputerError).code).toBe("DENIED");
      expect((error as Error).message).toMatch(/belongs to bot main/);
    }
    // And the token still works for the Bot it was minted for.
    expect(turns.verify(turn.id, "main").conversation_id).toBe("conv_a");
  });

  it("sweeps expired turns without a timer", () => {
    const turns = new TurnService(1000);
    const turn = turns.mint({ bot: "main", conversation_id: "conv_a" });
    turns.expire(Date.now() + 2000);
    expect(() => turns.verify(turn.id, "main")).toThrow(/unknown turn/);
  });
});
