// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationContext, inviteCodeFrom } from "./account.ts";
import { allGroups, groupAllowed, listedGroups } from "./groups.ts";

test("inviteCodeFrom accepts a chat.whatsapp.com link or a bare code", () => {
  assert.equal(inviteCodeFrom("https://chat.whatsapp.com/AbCdEf123456"), "AbCdEf123456");
  assert.equal(inviteCodeFrom("https://chat.whatsapp.com/invite/AbCdEf123456/"), "AbCdEf123456");
  assert.equal(inviteCodeFrom("chat.whatsapp.com/AbCdEf123456"), "AbCdEf123456");
  assert.equal(inviteCodeFrom("  AbCdEf123456  "), "AbCdEf123456");
  assert.equal(inviteCodeFrom(""), null);
  assert.equal(inviteCodeFrom("not a code!"), null);
});

// `all` ignores the list; `listed` with an empty list is no group at all, the
// state a freshly linked number sits in until the owner ticks a group.
test("groupAllowed distinguishes all, listed and listed-but-empty", () => {
  assert.equal(groupAllowed(allGroups, "1@g.us"), true);
  assert.equal(groupAllowed(listedGroups(["1@g.us"]), "1@g.us"), true);
  assert.equal(groupAllowed(listedGroups(["1@g.us"]), "2@g.us"), false);
  assert.equal(groupAllowed(listedGroups([]), "1@g.us"), false);
});

const opts = { botName: "Vibey", lookup: (user: string) => (user === "lid1" ? "Ada" : undefined) };

test("buildConversationContext drops the current message and labels the bot", () => {
  const block = buildConversationContext(
    [
      { n: "Ben", role: "user", s: "61400000000", t: 1, x: "hello" },
      { role: "assistant", s: "bot", t: 2, x: "hi Ben" },
      { role: "user", s: "lid1", t: 3, x: "what did I miss?" },
      { n: "Ben", role: "user", s: "61400000000", t: 4, x: "the current message" },
    ],
    { ...opts, surface: "group" },
  );
  assert.equal(
    block,
    "Recent group conversation (most recent last), for context only:\nBen: hello\nVibey: hi Ben\nAda: what did I miss?",
  );
});

test("buildConversationContext is null with nothing prior and clips long lines", () => {
  assert.equal(buildConversationContext([{ s: "a", t: 1, x: "only" }], opts), null);
  const block = buildConversationContext(
    [
      { n: "Ben", s: "a", t: 1, x: "x".repeat(400) },
      { n: "Ben", s: "a", t: 2, x: "now" },
    ],
    { ...opts, surface: "dm" },
  );
  assert.ok(block?.startsWith("Recent conversation (most recent last), for context only:\nBen: "));
  assert.ok(block?.endsWith("..."));
  assert.equal(
    block?.length,
    "Recent conversation (most recent last), for context only:\nBen: ".length + 303,
  );
});
