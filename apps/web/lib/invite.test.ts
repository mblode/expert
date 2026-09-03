import { describe, expect, it, vi } from "vitest";

import { DEFAULT_HUB_URL } from "./config";
import { computerById, issueSeat, VIBEY_HUB_URL } from "./computers";
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

  it("accepts Eve's kind field and maps plugin to the plugins path purpose", () => {
    const desk = planInvite({ kind: "desk" }, env(), now);
    expect(desk).not.toHaveProperty("error");
    if ("error" in desk) {
      return;
    }
    expect(desk.purpose).toBe("desk");

    const plugin = planInvite({ kind: "plugin" }, env(), now);
    expect(plugin).not.toHaveProperty("error");
    if ("error" in plugin) {
      return;
    }
    expect(plugin.purpose).toBe("plugins");

    expect(planInvite({ kind: "widgets" }, env(), now)).toMatchObject({ status: 400 });
    expect(planInvite({ purpose: "plugin" }, env(), now)).not.toHaveProperty("error");
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
  /** A hub that answers Pair, Issue and Revoke, recording what it was asked. */
  function fakeHub(): {
    calls: { body: unknown; method: string; token?: string; url: string }[];
    fetchImpl: typeof fetch;
  } {
    const calls: { body: unknown; method: string; token?: string; url: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const method = String(input).split("/computer.v1.Seat/")[1] ?? "";
      const auth = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({
        body: JSON.parse(String(init?.body)),
        method,
        url: String(input),
        ...(auth ? { token: auth.replace("Bearer ", "") } : {}),
      });
      if (method === "Pair") {
        return Response.json({ token: "owner_ephemeral" }, { status: 200 });
      }
      if (method === "Issue") {
        const asked = JSON.parse(String(init?.body)) as { role: string; ttl_sec: number };
        return Response.json(
          {
            expires_at: new Date(now + asked.ttl_sec * 1000).toISOString(),
            role: asked.role,
            token: `seat_${asked.role}`,
          },
          { status: 200 },
        );
      }
      return Response.json({ revoked: true }, { status: 200 });
    });
    return { calls, fetchImpl };
  }

  const issueWith =
    (fetchImpl: typeof fetch): typeof issueSeat =>
    (computer, given, request) =>
      issueSeat(computer, given, request, fetchImpl);

  it("issues a guest bound to the screen, expiring with the link, never an owner", async () => {
    const { calls, fetchImpl } = fakeHub();
    const granted = await grantInviteSeat(draftInvite(), "desk", env(), now, issueWith(fetchImpl));

    expect(granted).toEqual({
      computer: computerById("vibey", env()),
      disposable: false,
      persist: true,
      role: "guest",
      seatToken: "seat_guest",
    });
    // Vibey's hub with Vibey's code, never Blode's.
    expect(calls[0]).toEqual({
      body: { code: vibeyCode },
      method: "Pair",
      url: `${VIBEY_HUB_URL}/computer.v1.Seat/Pair`,
    });
    expect(calls.every((call) => call.url.startsWith(VIBEY_HUB_URL))).toBe(true);
    expect(calls.every((call) => !call.url.includes(new URL(DEFAULT_HUB_URL).host))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(blodeCode);

    const issue = calls.find((call) => call.method === "Issue");
    expect(issue?.body).toEqual({
      display: 1,
      label: "hello.expert desk invite",
      role: "guest",
      // The link has 30 minutes left, so the seat asks for 30 minutes. The
      // hub, not this, is what caps a guest seat.
      subject: `invite:${draftInvite().tokenHash.slice(0, 12)}`,
      ttl_sec: 30 * 60,
    });
    expect(issue?.body).not.toHaveProperty("methods");
    expect(issue?.token).toBe("owner_ephemeral");
  });

  it("spends the paired owner on one grant and revokes it in the same request", async () => {
    const { calls, fetchImpl } = fakeHub();
    await grantInviteSeat(draftInvite(), "desk", env(), now, issueWith(fetchImpl));

    // No owner token survives the request, so none can be stored on the invite.
    expect(calls.map((call) => call.method)).toEqual(["Pair", "Issue", "Revoke"]);
    expect(calls.at(-1)).toMatchObject({ body: {}, method: "Revoke", token: "owner_ephemeral" });
  });

  it("does not honour an owner token stored before scoped seats: it revokes it", async () => {
    const { calls, fetchImpl } = fakeHub();
    // A record written by the old path: a seat token and no role.
    const granted = await grantInviteSeat(
      draftInvite({ seatToken: "owner_from_before" }),
      "desk",
      env(),
      now,
      issueWith(fetchImpl),
    );
    expect(granted).toMatchObject({ persist: true, role: "guest", seatToken: "seat_guest" });

    const revoke = calls.find((call) => call.method === "Revoke");
    expect(revoke).toMatchObject({
      body: { token: "owner_from_before" },
      method: "Revoke",
      token: "owner_ephemeral",
    });
  });

  it("reuses a seat this control plane already minted under the scoped scheme", async () => {
    const issue = vi.fn();
    const granted = await grantInviteSeat(
      draftInvite({ seatRole: "guest", seatToken: "seat_reuse" }),
      "desk",
      env(),
      now,
      issue as unknown as typeof issueSeat,
    );
    expect(granted).toEqual({
      computer: computerById("vibey", env()),
      disposable: false,
      persist: false,
      role: "guest",
      seatToken: "seat_reuse",
    });
    expect(issue).not.toHaveBeenCalled();
  });

  it("gives a plugins link the narrowest seat that can author a connection file", async () => {
    const { calls, fetchImpl } = fakeHub();
    const granted = await grantInviteSeat(
      draftInvite({ purpose: "plugins" }),
      "plugins",
      env(),
      now,
      issueWith(fetchImpl),
    );
    // Disposable and never stored: the route revokes it when the write returns.
    expect(granted).toMatchObject({ disposable: true, persist: false, seatToken: "seat_owner" });

    const issue = calls.find((call) => call.method === "Issue");
    expect(issue?.body).toMatchObject({
      // Writing a connection file means CreateBot, Agent.WriteFile, DeleteBot.
      // No role but owner carries CreateBot, so the containment is the method
      // list and the two-minute life, and `isOwner` on the hub still sees an
      // owner. That gap is the PR's second finding.
      methods: [
        "/computer.v1.Seat/CreateBot",
        "/computer.v1.Seat/DeleteBot",
        "/computer.v1.Seat/Revoke",
      ],
      role: "owner",
      ttl_sec: 120,
    });
    expect(issue?.body).not.toHaveProperty("display");
  });

  it("never asks for a seat longer than the link has left", async () => {
    const { calls, fetchImpl } = fakeHub();
    const ttlAsked = (asked: { body: unknown; method: string }[]): unknown =>
      (asked.find((call) => call.method === "Issue")?.body as { ttl_sec?: unknown } | undefined)
        ?.ttl_sec;

    const nearlyDone = draftInvite({ expiresAt: now + 45_000 });
    await grantInviteSeat(nearlyDone, "desk", env(), now, issueWith(fetchImpl));
    expect(ttlAsked(calls)).toBe(45);

    // The plugins seat asks for two minutes, and never more than the link.
    const { calls: pluginCalls, fetchImpl: pluginFetch } = fakeHub();
    await grantInviteSeat(
      { ...nearlyDone, purpose: "plugins" },
      "plugins",
      env(),
      now,
      issueWith(pluginFetch),
    );
    expect(ttlAsked(pluginCalls)).toBe(45);
  });

  it("refuses to mint when that computer's setup code is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const result = await grantInviteSeat(
      draftInvite(),
      "desk",
      { COMPUTER_SETUP_CODE: blodeCode },
      now,
      issueWith(fetchImpl),
    );
    expect(result).toEqual({
      error:
        "The web server is missing COMPUTER_SETUP_CODE_VCMC, so it cannot attach to the Vibey computer.",
      status: 502,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not touch a hub for a wrong-computer invite", async () => {
    const issue = vi.fn();
    const result = await grantInviteSeat(
      draftInvite({ computerId: "ghost" }),
      "desk",
      env(),
      now,
      issue as unknown as typeof issueSeat,
    );
    expect(result).toMatchObject({ status: 404 });
    expect(issue).not.toHaveBeenCalled();
  });
});
