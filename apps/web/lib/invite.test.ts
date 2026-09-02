import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HUB_URL } from "./config";
import { computerById, pairComputer, VIBEY_HUB_URL } from "./computers";
import {
  DEFAULT_INVITE_COMPUTER_ID,
  grantInviteSeat,
  hashInviteSender,
  hashInviteToken,
  inspectInvite,
  MAX_INVITE_TTL_MINUTES,
  planInvite,
} from "./invite";
import type { InviteRecord } from "./invite";

const blodeCode = "blode-setup";
const vibeyCode = "vibey-setup";
const now = 1_700_000_000_000;

function env(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    COMPUTER_SETUP_CODE: blodeCode,
    COMPUTER_SETUP_CODE_VCMC: vibeyCode,
    ...extra,
  };
}

function draftInvite(
  extra: Partial<InviteRecord> & { purpose?: InviteRecord["purpose"] } = {},
): InviteRecord {
  return {
    computerId: "vibey",
    expiresAt: now + 30 * 60_000,
    purpose: "desk",
    tokenHash: "abc",
    ...extra,
  };
}

describe("planInvite", () => {
  it("defaults a mint to vibey, not blode", () => {
    const planned = planInvite({ purpose: "desk" }, env(), now);
    expect(planned).not.toHaveProperty("error");
    if ("error" in planned) {
      return;
    }
    expect(DEFAULT_INVITE_COMPUTER_ID).toBe("vibey");
    expect(planned.computerId).toBe("vibey");
    expect(planned.purpose).toBe("desk");
    expect(planned.expiresAt).toBe(now + 30 * 60_000);
    expect(planned.tokenHash).toBe(hashInviteToken(planned.token));
    expect(planned.tokenHash).not.toBe(planned.token);
  });

  it("maps leftover vcmc onto vibey and refuses an unknown computer", () => {
    const mapped = planInvite({ computerId: "vcmc", purpose: "plugins" }, env(), now);
    expect(mapped).not.toHaveProperty("error");
    if ("error" in mapped) {
      return;
    }
    expect(mapped.computerId).toBe("vibey");
    expect(mapped.purpose).toBe("plugins");

    expect(planInvite({ computerId: "ghost", purpose: "desk" }, env(), now)).toEqual({
      error: "That computer is not on this control plane.",
      status: 400,
    });
  });

  it("rejects a TTL of days and stores a hashed sender, not the raw one", () => {
    expect(planInvite({ purpose: "desk", ttlMinutes: 0 }, env(), now)).toMatchObject({
      status: 400,
    });
    expect(
      planInvite({ purpose: "desk", ttlMinutes: MAX_INVITE_TTL_MINUTES + 1 }, env(), now),
    ).toMatchObject({ status: 400 });
    expect(planInvite({ purpose: "desk", ttlMinutes: 24 * 60 }, env(), now)).toMatchObject({
      status: 400,
    });

    const sender = "whatsapp:+61400000000";
    const planned = planInvite({ purpose: "desk", sender }, env(), now);
    expect(planned).not.toHaveProperty("error");
    if ("error" in planned) {
      return;
    }
    expect(planned.senderHash).toBe(hashInviteSender(sender));
    expect(JSON.stringify(planned)).not.toContain(sender);
    expect(JSON.stringify(planned)).not.toContain("+614");
  });
});

describe("inspectInvite", () => {
  it("refuses an expired link", () => {
    expect(inspectInvite(draftInvite({ expiresAt: now }), "desk", env(), now)).toEqual({
      error: "This link has expired. Ask for a new one.",
      status: 410,
    });
    expect(inspectInvite(draftInvite({ expiresAt: now - 1 }), "desk", env(), now)).toMatchObject({
      status: 410,
    });
    const live = inspectInvite(draftInvite({ expiresAt: now + 1 }), "desk", env(), now);
    expect(live).toEqual({ computer: computerById("vibey", env()) });
  });

  it("refuses a missing invite, a purpose mismatch, and a computer that is gone", () => {
    expect(inspectInvite(undefined, "desk", env(), now)).toEqual({
      error: "This link is not valid.",
      status: 404,
    });
    expect(inspectInvite(draftInvite({ purpose: "desk" }), "plugins", env(), now)).toEqual({
      error: "This link is for the desk, not plugins.",
      status: 404,
    });
    expect(inspectInvite(draftInvite({ computerId: "ghost" }), "desk", env(), now)).toEqual({
      error: "That computer is not on this control plane.",
      status: 404,
    });
  });
});

describe("grantInviteSeat", () => {
  it("pairs the invite's computer, never Blode, for a Vibey desk link", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(`${VIBEY_HUB_URL}/computer.v1.Seat/Pair`);
      expect(String(input)).not.toContain(new URL(DEFAULT_HUB_URL).host);
      expect(JSON.parse(String(init?.body))).toEqual({ code: vibeyCode });
      expect(JSON.parse(String(init?.body)).code).not.toBe(blodeCode);
      return Response.json({ token: "seat_vibey" }, { status: 200 });
    });
    const pair: typeof pairComputer = (computer, given) => pairComputer(computer, given, fetchImpl);

    const granted = await grantInviteSeat(draftInvite(), "desk", env(), now, pair);
    expect(granted).toEqual({
      computer: computerById("vibey", env()),
      persist: true,
      seatToken: "seat_vibey",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("reuses a seat already minted for this invite", async () => {
    const pair = vi.fn();
    const granted = await grantInviteSeat(
      draftInvite({ seatToken: "seat_reuse" }),
      "desk",
      env(),
      now,
      pair,
    );
    expect(granted).toEqual({
      computer: computerById("vibey", env()),
      persist: false,
      seatToken: "seat_reuse",
    });
    expect(pair).not.toHaveBeenCalled();
  });

  it("refuses to pair when that computer's setup code is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const pair: typeof pairComputer = (computer, given) => pairComputer(computer, given, fetchImpl);
    const result = await grantInviteSeat(
      draftInvite(),
      "desk",
      { COMPUTER_SETUP_CODE: blodeCode },
      now,
      pair,
    );
    expect(result).toEqual({
      error:
        "The web server is missing COMPUTER_SETUP_CODE_VCMC, so it cannot attach to the Vibey computer.",
      status: 502,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not pair a wrong-computer invite", async () => {
    const pair = vi.fn();
    const result = await grantInviteSeat(
      draftInvite({ computerId: "ghost" }),
      "desk",
      env(),
      now,
      pair,
    );
    expect(result).toMatchObject({ status: 404 });
    expect(pair).not.toHaveBeenCalled();
  });
});
