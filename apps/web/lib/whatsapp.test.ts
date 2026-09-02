import { describe, expect, it } from "vitest";

import type { WhatsAppConfig, WhatsAppGroup, WhatsAppLinkState } from "./seat";
import {
  applyAllowedGroups,
  applySettingsDraft,
  defaultLinkMethod,
  formatPairingCode,
  inviteCode,
  jidToPhone,
  nextAllowedGroups,
  normalisePhone,
  parseAllowlist,
  phoneToJid,
  reduceLink,
  settingsDraft,
} from "./whatsapp";
import type { LinkView } from "./whatsapp";

describe("normalisePhone", () => {
  it("keeps digits only and drops the plus", () => {
    expect(normalisePhone("+61 412 345 678")).toBe("61412345678");
    expect(normalisePhone("(44) 7700-900123")).toBe("447700900123");
  });

  it("strips the dial-out prefix", () => {
    expect(normalisePhone("0061412345678")).toBe("61412345678");
  });

  it("refuses a local number with no country code", () => {
    expect(normalisePhone("0412 345 678")).toBeNull();
  });

  it("refuses too few or too many digits", () => {
    expect(normalisePhone("12345")).toBeNull();
    expect(normalisePhone("1234567890123456")).toBeNull();
    expect(normalisePhone("")).toBeNull();
  });
});

describe("formatPairingCode", () => {
  it("splits eight characters into two groups", () => {
    expect(formatPairingCode("abcd1234")).toBe("ABCD-1234");
    expect(formatPairingCode("ABCD-1234")).toBe("ABCD-1234");
  });

  it("leaves an unexpected shape alone", () => {
    expect(formatPairingCode("ABC")).toBe("ABC");
  });
});

describe("inviteCode", () => {
  it("unwraps an invite link", () => {
    expect(inviteCode("https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQrStUv")).toBe(
      "AbCdEfGhIjKlMnOpQrStUv",
    );
    expect(inviteCode("  https://chat.whatsapp.com/invite/AbCdEfGhIjKlMnOpQrStUv/ \n")).toBe(
      "AbCdEfGhIjKlMnOpQrStUv",
    );
  });

  it("accepts a bare code and refuses noise", () => {
    expect(inviteCode("AbCdEfGhIjKlMnOpQrStUv")).toBe("AbCdEfGhIjKlMnOpQrStUv");
    expect(inviteCode("hello")).toBeNull();
    expect(inviteCode("https://example.com/AbCdEfGhIjKlMnOpQrStUv")).toBeNull();
  });
});

describe("jid helpers", () => {
  it("shows a user jid as a number and keeps other jids raw", () => {
    expect(jidToPhone("61412345678@s.whatsapp.net")).toBe("+61412345678");
    expect(jidToPhone("123-456@g.us")).toBe("123-456@g.us");
    expect(jidToPhone(undefined)).toBe("");
  });

  it("turns a number back into a jid, passes a jid through, and flags junk", () => {
    expect(phoneToJid("+61 412 345 678")).toBe("61412345678@s.whatsapp.net");
    expect(phoneToJid("123-456@g.us")).toBe("123-456@g.us");
    expect(phoneToJid("  ")).toBe("");
    expect(phoneToJid("0412")).toBeNull();
  });

  it("parses an allowlist by line or comma and reports what it could not read", () => {
    expect(parseAllowlist("+61 412 345 678\n447700900123, +61412345678\n\nabc")).toEqual({
      invalid: ["abc"],
      jids: ["61412345678@s.whatsapp.net", "447700900123@s.whatsapp.net"],
    });
  });
});

describe("defaultLinkMethod", () => {
  it("prefers the code on touch, the QR elsewhere", () => {
    expect(defaultLinkMethod(true)).toBe("code");
    expect(defaultLinkMethod(false)).toBe("qr");
  });
});

const groups: WhatsAppGroup[] = [
  { enabled: true, jid: "a@g.us", size: 3, subject: "A" },
  { enabled: true, jid: "b@g.us", size: 5, subject: "B" },
  { enabled: false, jid: "c@g.us", size: 9, subject: "C" },
];

describe("nextAllowedGroups", () => {
  it("adds and removes from an explicit list", () => {
    expect(nextAllowedGroups(["a@g.us"], groups, "b@g.us", true)).toEqual(["a@g.us", "b@g.us"]);
    expect(nextAllowedGroups(["a@g.us", "b@g.us"], groups, "a@g.us", false)).toEqual(["b@g.us"]);
  });

  it("does not duplicate a group already on the list", () => {
    expect(nextAllowedGroups(["a@g.us"], groups, "a@g.us", true)).toEqual(["a@g.us"]);
  });

  it("spells out the enabled set when the list was empty, so one flip off does not become a list of one", () => {
    expect(nextAllowedGroups([], groups, "a@g.us", false)).toEqual(["b@g.us"]);
    expect(nextAllowedGroups([], groups, "c@g.us", true)).toEqual(["a@g.us", "b@g.us", "c@g.us"]);
  });

  it("re-derives enabled from the written list", () => {
    expect(applyAllowedGroups(groups, ["c@g.us"]).map((group) => group.enabled)).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("under group_policy all every group is enabled whatever the list says", () => {
    expect(applyAllowedGroups(groups, [], "all").every((group) => group.enabled)).toBe(true);
  });

  it("under group_policy listed an empty list means none, so the last switch off stays off", () => {
    expect(nextAllowedGroups(["a@g.us"], groups, "a@g.us", false, "listed")).toEqual([]);
    expect(applyAllowedGroups(groups, [], "listed").some((group) => group.enabled)).toBe(false);
  });
});

const config: WhatsAppConfig = {
  allowed_groups: ["a@g.us"],
  digest_recipient_jids: ["1@s.whatsapp.net"],
  dm_policy: "members",
  image_sends_per_day: 20,
  maintainer_jid: "61412345678@s.whatsapp.net",
  trigger_mode: "mention",
};

describe("settings draft", () => {
  it("round-trips a config through the form", () => {
    const draft = settingsDraft(config);
    expect(draft).toEqual({
      botName: "",
      dmAllowlist: "",
      dmPolicy: "members",
      maintainer: "+61412345678",
      triggerMode: "mention",
      triggerPrefix: "",
    });
    expect(applySettingsDraft(config, draft)).toEqual({
      config: { ...config, bot_name: undefined },
    });
  });

  it("carries fields the form does not show", () => {
    const result = applySettingsDraft(config, {
      ...settingsDraft(config),
      botName: " Eve ",
      dmAllowlist: "+44 7700 900123",
      dmPolicy: "allowlist",
      triggerMode: "prefix",
      triggerPrefix: "!eve",
    });
    expect(result).toEqual({
      config: {
        ...config,
        bot_name: "Eve",
        dm_allowlist: ["447700900123@s.whatsapp.net"],
        dm_policy: "allowlist",
        trigger_mode: "prefix",
        trigger_prefix: "!eve",
      },
    });
  });

  it("clears the maintainer when the field is blanked", () => {
    const result = applySettingsDraft(config, { ...settingsDraft(config), maintainer: "" });
    expect("config" in result && result.config.maintainer_jid).toBeUndefined();
  });

  it("refuses what it cannot read back", () => {
    const base = settingsDraft(config);
    expect(applySettingsDraft(config, { ...base, maintainer: "0412" })).toHaveProperty("error");
    expect(applySettingsDraft(config, { ...base, triggerMode: "prefix" })).toHaveProperty("error");
    expect(
      applySettingsDraft(config, { ...base, dmAllowlist: "nope", dmPolicy: "allowlist" }),
    ).toHaveProperty("error");
  });
});

function state(partial: Partial<WhatsAppLinkState>): WhatsAppLinkState {
  return {
    acct: "main",
    age_ms: null,
    pairing_code: null,
    phone: null,
    qr: null,
    status: "unlinked",
    ...partial,
  };
}

describe("reduceLink", () => {
  const loading: LinkView = { kind: "loading" };

  it("reads the account list", () => {
    expect(
      reduceLink(loading, {
        accounts: [{ acct: "main", bot: "main", phone: "614", status: "open" }],
        acct: "main",
        type: "accounts",
      }),
    ).toEqual({ kind: "linked", phone: "614" });
    expect(reduceLink(loading, { accounts: [], acct: "main", type: "accounts" })).toEqual({
      kind: "unlinked",
    });
  });

  it("keeps the chosen method across polls and carries the code or QR", () => {
    const started = reduceLink(loading, {
      method: "code",
      state: state({ phone: "614", status: "linking" }),
      type: "state",
    });
    expect(started).toEqual({
      code: null,
      kind: "linking",
      method: "code",
      phone: "614",
      qr: null,
    });
    const polled = reduceLink(started, {
      state: state({ pairing_code: "ABCD1234", phone: "614", qr: "raw", status: "linking" }),
      type: "state",
    });
    expect(polled).toMatchObject({ code: "ABCD1234", method: "code", qr: "raw" });
  });

  it("infers the method after a reload from what the hub is holding", () => {
    expect(
      reduceLink(loading, { state: state({ qr: "raw", status: "linking" }), type: "state" }),
    ).toMatchObject({ method: "qr" });
    expect(
      reduceLink(loading, {
        accounts: [{ acct: "main", bot: "main", phone: "614", status: "linking" }],
        acct: "main",
        type: "accounts",
      }),
    ).toMatchObject({ code: null, kind: "linking", method: "code" });
  });

  it("follows open, closed, down and unlink", () => {
    const linking: LinkView = { code: null, kind: "linking", method: "qr", phone: null, qr: "x" };
    expect(
      reduceLink(linking, { state: state({ phone: "614", status: "open" }), type: "state" }),
    ).toEqual({ kind: "linked", phone: "614" });
    expect(
      reduceLink(linking, { state: state({ phone: "614", status: "closed" }), type: "state" }),
    ).toEqual({ kind: "closed", phone: "614" });
    expect(reduceLink(linking, { type: "down" })).toEqual({ kind: "down" });
    expect(reduceLink(linking, { type: "unlinked" })).toEqual({ kind: "unlinked" });
  });
});
