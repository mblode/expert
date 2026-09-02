// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { isOwner, parseOwnerIds } from "./owner.ts";

test("parseOwnerIds normalizes phones, JIDs and lids to digit ids", () => {
  const owners = parseOwnerIds(" +61456455551 , 61456455551@s.whatsapp.net, 123456789012@lid ,, ");
  assert.deepEqual([...owners].toSorted(), ["123456789012", "61456455551"]);
});

test("parseOwnerIds returns an empty set for unset/empty input", () => {
  assert.equal(parseOwnerIds().size, 0);
  assert.equal(parseOwnerIds("").size, 0);
  assert.equal(parseOwnerIds(" , ").size, 0);
});

test("isOwner matches via senderPhone when the sender is an opaque lid", () => {
  const owners = parseOwnerIds("+61456455551");
  assert.equal(isOwner(owners, "999888777666@lid", "61456455551"), true);
});

test("isOwner matches via an @lid entry when senderPhone is null", () => {
  const owners = parseOwnerIds("+61456455551,999888777666@lid");
  assert.equal(isOwner(owners, "999888777666@lid", null), true);
});

test("isOwner matches a full JID sender against a phone entry", () => {
  const owners = parseOwnerIds("+61456455551");
  assert.equal(isOwner(owners, "61456455551@s.whatsapp.net", null), true);
});

test("isOwner tolerates the AU national form", () => {
  const owners = parseOwnerIds("+61456455551");
  assert.equal(isOwner(owners, "0456455551@s.whatsapp.net", null), true);
});

test("isOwner rejects non-owners and empty identities", () => {
  const owners = parseOwnerIds("+61456455551");
  assert.equal(isOwner(owners, "61400000000@s.whatsapp.net", "61400000000"), false);
  assert.equal(isOwner(owners, "", null), false);
});

test("isOwner is false when no owners are configured", () => {
  assert.equal(isOwner(new Set<string>(), "61456455551@s.whatsapp.net", "61456455551"), false);
});
