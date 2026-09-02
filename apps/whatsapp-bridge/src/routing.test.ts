// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOwnerIds } from "./owner.ts";
import { shouldReply } from "./routing.ts";
import type { DmPolicy } from "./routing.ts";
import type { Whitelist } from "./whitelist.ts";

const whitelistOf = (members: string[]): Whitelist => ({
  isMember: (num) => members.includes(num ?? ""),
  ready: () => true,
});

const members: DmPolicy = { dmAllowlist: new Set(), dm_policy: "members" };

const base = {
  isSelfChat: false,
  policy: members,
  whitelist: whitelistOf(["61400000000", "61456455551"]),
};

test("owner DM is answered because the owner is a listed member", () => {
  assert.equal(
    shouldReply({ ...base, isDM: true, sender: "999888777666@lid", senderPhone: "61456455551" }),
    true,
  );
});

test("owner DM is ignored when the owner is not a member", () => {
  // There is no owner exemption under the members policy: dropping the owner
  // from the live participant set silently stops the Bot answering them.
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "61456455551@s.whatsapp.net",
      senderPhone: "61456455551",
      whitelist: whitelistOf(["61400000000"]),
    }),
    false,
  );
});

test("member DM is answered", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "61400000000@s.whatsapp.net",
      senderPhone: "61400000000",
    }),
    true,
  );
});

test("non-member DM is ignored", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "61411111111@s.whatsapp.net",
      senderPhone: "61411111111",
    }),
    false,
  );
});

test("DM whitelist gate falls back to the sender when senderPhone is null", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "61400000000@s.whatsapp.net",
      senderPhone: null,
      whitelist: whitelistOf(["61400000000@s.whatsapp.net"]),
    }),
    true,
  );
});

test("the account's own self-chat is answered under every policy", () => {
  for (const dm_policy of ["members", "allowlist", "anyone"] as const) {
    assert.equal(
      shouldReply({
        ...base,
        isDM: true,
        isSelfChat: true,
        policy: { dmAllowlist: new Set(), dm_policy },
        // Sender is the bot's own number: not a listed member.
        sender: "61494718128@s.whatsapp.net",
        senderPhone: "61494718128",
        whitelist: whitelistOf([]),
      }),
      true,
      dm_policy,
    );
  }
});

test("group messages are always answered, even from a non-member", () => {
  for (const dm_policy of ["members", "allowlist", "anyone"] as const) {
    assert.equal(
      shouldReply({
        ...base,
        isDM: false,
        policy: { dmAllowlist: new Set(), dm_policy },
        sender: "61411111111@s.whatsapp.net",
        senderPhone: "61411111111",
        whitelist: whitelistOf([]),
      }),
      true,
      dm_policy,
    );
  }
});

test("a live lid matches even when senderPhone is a different identity", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "216543000111",
      senderPhone: "61499999999",
      whitelist: whitelistOf(["216543000111"]),
    }),
    true,
  );
});

test("a not-ready whitelist lets member DMs through (fails open)", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      sender: "61411111111@s.whatsapp.net",
      senderPhone: "61411111111",
      whitelist: { isMember: () => false, ready: () => false },
    }),
    true,
  );
});

// The allowlist policy ignores the live set entirely: a group member who is not
// on the list gets no reply, and a listed number that is in no group does.
test("allowlist policy answers only dm_allowlist identities", () => {
  const policy: DmPolicy = {
    dmAllowlist: parseOwnerIds("+61422222222, 999888777666@lid"),
    dm_policy: "allowlist",
  };
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      policy,
      sender: "61400000000@s.whatsapp.net",
      senderPhone: "61400000000",
    }),
    false,
    "a live member off the list is refused",
  );
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      policy,
      sender: "0422222222@s.whatsapp.net",
      senderPhone: null,
      whitelist: whitelistOf([]),
    }),
    true,
    "a listed phone in national form is answered",
  );
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      policy,
      sender: "999888777666@lid",
      senderPhone: null,
      whitelist: whitelistOf([]),
    }),
    true,
    "a listed lid is answered",
  );
});

test("anyone policy answers every DM", () => {
  assert.equal(
    shouldReply({
      ...base,
      isDM: true,
      policy: { dmAllowlist: new Set(), dm_policy: "anyone" },
      sender: "15550001111@s.whatsapp.net",
      senderPhone: "15550001111",
      whitelist: whitelistOf([]),
    }),
    true,
  );
});
