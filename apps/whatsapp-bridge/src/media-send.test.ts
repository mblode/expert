// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { allGroups, listedGroups } from "./groups.ts";
import { createDailyCounter, sendTargetAllowed, parseSendMediaBody } from "./media-send.ts";

const gate = (overrides = {}) => ({
  groups: allGroups,
  isMember: () => false,
  isOwnerJid: () => false,
  maintainerJid: "",
  ...overrides,
});

test("parseSendMediaBody validates jid, image mime and base64", () => {
  assert.deepEqual(parseSendMediaBody({}), { error: "jid required" });
  assert.deepEqual(parseSendMediaBody({ base64: "aGk=", jid: "x@g.us", mime: "text/plain" }), {
    error: "mime must be an image/* type",
  });
  assert.deepEqual(parseSendMediaBody({ jid: "x@g.us", mime: "image/png" }), {
    error: "base64 required",
  });
  assert.deepEqual(
    parseSendMediaBody({
      base64: "aGk=",
      caption: "  a kangaroo  ",
      jid: " x@g.us ",
      mime: "image/png",
    }),
    {
      payload: {
        base64: "aGk=",
        caption: "a kangaroo",
        jid: "x@g.us",
        mime: "image/png",
      },
    },
  );
  // Blank caption is dropped, not forwarded as "".
  const parsed = parseSendMediaBody({
    base64: "aGk=",
    caption: "  ",
    jid: "x@g.us",
    mime: "image/jpeg",
  });
  assert.ok("payload" in parsed && parsed.payload.caption === undefined);
});

test("sendTargetAllowed gates groups on the group allowlist", () => {
  // Empty allowlist = all groups allowed (mirrors inbound handling).
  assert.equal(sendTargetAllowed("123@g.us", gate()), true);
  assert.equal(sendTargetAllowed("123@g.us", gate({ groups: listedGroups(["456@g.us"]) })), false);
  assert.equal(sendTargetAllowed("456@g.us", gate({ groups: listedGroups(["456@g.us"]) })), true);
});

test("sendTargetAllowed gates DMs on maintainer, owner, or member", () => {
  assert.equal(sendTargetAllowed("61400000000@s.whatsapp.net", gate()), false);
  assert.equal(
    sendTargetAllowed(
      "61400000000@s.whatsapp.net",
      gate({ maintainerJid: "61400000000@s.whatsapp.net" }),
    ),
    true,
  );
  assert.equal(
    sendTargetAllowed(
      "61400000000@s.whatsapp.net",
      gate({ isOwnerJid: (jid: string) => jid.startsWith("61400000000") }),
    ),
    true,
  );
  assert.equal(
    sendTargetAllowed(
      "61411111111@s.whatsapp.net",
      gate({
        isMember: (num: string | null | undefined) => num === "61411111111",
      }),
    ),
    true,
  );
  assert.equal(sendTargetAllowed("", gate({ isMember: () => true })), false);
});

test("createDailyCounter caps per key and resets on day rollover", () => {
  let day = "2026-07-09";
  const counter = createDailyCounter(2, () => day);
  assert.equal(counter.take("a@g.us"), true);
  assert.equal(counter.take("a@g.us"), true);
  assert.equal(counter.take("a@g.us"), false);
  // Other keys have their own budget.
  assert.equal(counter.take("b@g.us"), true);
  // New day, fresh budget.
  day = "2026-07-10";
  assert.equal(counter.take("a@g.us"), true);
});
