import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVAL_AUTH_HEADERS, evalHeaderAuth } from "./eval-auth.js";

const ALL_HEADERS = {
  [EVAL_AUTH_HEADERS.chatJid]: "120363000000000000@g.us",
  [EVAL_AUTH_HEADERS.sender]: "8888888888888888@lid",
  [EVAL_AUTH_HEADERS.senderName]: "Adam",
  [EVAL_AUTH_HEADERS.senderPhone]: "61400000000@s.whatsapp.net",
};

const req = (headers: Record<string, string> = ALL_HEADERS): Request =>
  new Request("http://127.0.0.1/eve/v1/sessions", { headers });

const original = process.env.EVE_EVAL_FIXTURES;

/** Restore the ambient flag so one case can't leave another one armed. */
const resetFlag = (): void => {
  process.env.EVE_EVAL_FIXTURES = original ?? "";
};

describe("evalHeaderAuth (closed by default)", () => {
  beforeEach(resetFlag);
  afterEach(resetFlag);

  /**
   * THE test. This strategy is mounted ahead of every other one in
   * `agent/channels/eve.ts`, and the identity it mints picks its own `groupJid`
   * — which is the scope key for reading and writing a group's memory. If it
   * ever answers a request without the env flag, anyone who can reach the
   * deployment can name any group and read or overwrite its memory.
   *
   * The flag is set only by the eval harness and never on the Vercel
   * deployment, so "no flag, no identity" is the entire security boundary. Do
   * not relax this to accept a Host, Origin, Referer, User-Agent or any other
   * caller-supplied signal: eve hardened its own `localDev()` in 0.30.0 for
   * exactly that mistake.
   */
  it("returns null with the flag unset, even with every header present", () => {
    process.env.EVE_EVAL_FIXTURES = "";
    expect(evalHeaderAuth()(req())).toBeNull();
  });

  it("stays closed for values that are not an explicit opt-in", () => {
    for (const value of ["0", "false", "no", "off", " ", "yes-please"]) {
      process.env.EVE_EVAL_FIXTURES = value;
      expect(evalHeaderAuth()(req())).toBeNull();
    }
  });

  it("returns null when the flag is armed but no chat jid is sent", () => {
    // Evals that don't want a group must keep falling through to localDev().
    process.env.EVE_EVAL_FIXTURES = "1";
    expect(evalHeaderAuth()(req({ [EVAL_AUTH_HEADERS.sender]: "x@lid" }))).toBeNull();
    expect(evalHeaderAuth()(req({ [EVAL_AUTH_HEADERS.chatJid]: "   " }))).toBeNull();
  });
});

describe("evalHeaderAuth (armed)", () => {
  beforeEach(() => {
    process.env.EVE_EVAL_FIXTURES = "1";
  });
  afterEach(resetFlag);

  it("lifts the whatsapp identity off the headers", () => {
    // The shape has to match what agent/channels/whatsapp.ts builds, or the
    // session helpers read a group JID in eval that they'd never see in prod.
    expect(evalHeaderAuth()(req())).toStrictEqual({
      attributes: {
        groupJid: "120363000000000000@g.us",
        senderName: "Adam",
        senderPhone: "61400000000@s.whatsapp.net",
      },
      authenticator: "eval-fixture",
      principalId: "8888888888888888@lid",
      principalType: "user",
    });
  });

  it("accepts `true` as well as `1`", () => {
    process.env.EVE_EVAL_FIXTURES = "true";
    expect(evalHeaderAuth()(req())).not.toBeNull();
  });

  it("omits absent optional attributes rather than sending empty strings", () => {
    // senderPhone drives admin gating; an empty string there would be a value
    // the matcher has to special-case.
    const auth = evalHeaderAuth()(req({ [EVAL_AUTH_HEADERS.chatJid]: "123@g.us" }));

    expect(auth).toStrictEqual({
      attributes: { groupJid: "123@g.us" },
      authenticator: "eval-fixture",
      // No sender: the chat is the principal, exactly as the bridge does it.
      principalId: "123@g.us",
      principalType: "user",
    });
  });
});
