import { describe, expect, it, vi } from "vitest";

import digest from "./digest.ts";

/**
 * The continuation token is the whole test surface here, and it earns a test
 * because getting it wrong failed *silently* for five days: the DM still went
 * out every morning, so nothing looked broken, while every recap was dropped.
 *
 * eve's `send` resumes whichever session already owns the address and only
 * creates one, the one path that applies `state`, when the address is unowned.
 * So a token that is constant per recipient pins that recipient's state to
 * whatever their very first run set, forever.
 *
 * Since eve 0.49 the token is the argument to `from(address)` rather than a
 * `continuationToken` option on `send`, so the spy captures both halves and
 * reassembles the shape the assertions care about.
 */

interface SendOptions {
  continuationToken: string;
  state: Record<string, unknown>;
}

const TARGET = {
  day: "2026-08-11",
  idempotencyKey: "digest#61400000000@s.whatsapp.net#2026-08-11",
  messageCount: 42,
  recipientJid: "61400000000@s.whatsapp.net",
  style: "tldr",
};

/** Invoke the channel's `receive` with spies standing in for eve's `from`. */
const callReceive = (over: Partial<typeof TARGET> = {}): SendOptions => {
  const send = vi.fn<
    (message: string, options: { state: Record<string, unknown> }) => Promise<object>
  >(() => Promise.resolve({}));
  const from = vi.fn<(address: string) => { send: typeof send }>(() => ({
    send,
  }));
  const channel = digest as unknown as {
    receive: (input: unknown, helpers: { from: typeof from }) => unknown;
  };
  channel.receive(
    {
      auth: { kind: "app" },
      message: "recap this",
      target: { ...TARGET, ...over },
    },
    { from },
  );
  const [fromCall] = from.mock.calls;
  const [sendCall] = send.mock.calls;
  if (!(fromCall && sendCall)) {
    throw new Error("receive did not call from(...).send(...)");
  }
  return { continuationToken: fromCall[0], state: sendCall[1].state };
};

describe("digest channel receive", () => {
  it("scopes the continuation token to the day", () => {
    expect(callReceive().continuationToken).toBe("digest#61400000000@s.whatsapp.net#2026-08-11");
  });

  it("starts a new session each day rather than resuming yesterday's", () => {
    // The regression. Two mornings must not share a token, or the second one
    // silently inherits the first one's state and `day` never advances.
    const monday = callReceive({ day: "2026-08-10" }).continuationToken;
    const tuesday = callReceive({ day: "2026-08-11" }).continuationToken;

    expect(monday).not.toBe(tuesday);
  });

  it("carries the whole handoff into the session's initial state", () => {
    // `state` only lands on session creation, so anything missing here is
    // missing for the life of the session — that is how `day` went absent.
    expect(callReceive().state).toMatchObject({
      day: "2026-08-11",
      idempotencyKey: TARGET.idempotencyKey,
      messageCount: 42,
      recipientJid: TARGET.recipientJid,
      style: "tldr",
    });
  });
});
