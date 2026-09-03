// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { createMessageIndex, isShortMessageId, shortMessageId } from "./message-ids.ts";

const key = (id: string, remoteJid = "1@g.us") => ({
  fromMe: false,
  id,
  participant: "61400000000@s.whatsapp.net",
  remoteJid,
});

test("remember returns a short stable id and resolves back to the key", () => {
  const index = createMessageIndex();
  const id = index.remember(key("ABC123"), "  hello there  ");
  assert.ok(id && isShortMessageId(id));
  // Derived, not allocated: the same message always yields the same token, so a
  // redelivered message does not hand the Bot a second id for one message.
  assert.equal(index.remember(key("ABC123"), "hello there"), id);
  assert.equal(index.size, 1);
  assert.deepEqual(index.lookup(id as string), {
    key: {
      fromMe: false,
      id: "ABC123",
      participant: "61400000000@s.whatsapp.net",
      remoteJid: "1@g.us",
    },
    preview: "hello there",
  });
});

test("the same message id in two chats is two different tokens", () => {
  assert.notEqual(shortMessageId("1@g.us", "ABC"), shortMessageId("2@g.us", "ABC"));
});

test("remember skips a key with no chat or no message id", () => {
  const index = createMessageIndex();
  assert.equal(index.remember({ id: "ABC", remoteJid: "" }), null);
  assert.equal(index.remember({ id: "", remoteJid: "1@g.us" }), null);
  assert.equal(index.remember(null), null);
  assert.equal(index.size, 0);
});

test("a caption-less message still gets a usable preview", () => {
  const index = createMessageIndex();
  const id = index.remember(key("IMG1"), "") as string;
  // Baileys renders the quoted stub from this text; an empty one shows as a
  // blank grey line above the reply.
  assert.equal(index.lookup(id)?.preview, "[message]");
});

test("the preview is clipped so the index cannot grow with message length", () => {
  const index = createMessageIndex();
  const id = index.remember(key("LONG"), "x".repeat(5000)) as string;
  assert.equal(index.lookup(id)?.preview.length, 200);
});

test("the index is bounded: the oldest ids fall off", () => {
  const index = createMessageIndex(3);
  const ids = ["a", "b", "c", "d"].map((n) => index.remember(key(n), n) as string);
  assert.equal(index.size, 3);
  // "a" evicted, which the envelope turns into a refusal rather than a leak.
  assert.equal(index.lookup(ids[0] as string), undefined);
  assert.equal(index.lookup(ids[3] as string)?.key.id, "d");
});

test("remembering an entry again refreshes its recency", () => {
  const index = createMessageIndex(2);
  const a = index.remember(key("a"), "a") as string;
  index.remember(key("b"), "b");
  index.remember(key("a"), "a");
  index.remember(key("c"), "c");
  // "b" was the least recently touched, so it is the one that went.
  assert.ok(index.lookup(a));
  assert.equal(index.size, 2);
});

test("lookup rejects anything that is not one of our ids", () => {
  const index = createMessageIndex();
  index.remember(key("ABC"), "hi");
  assert.equal(index.lookup("../../etc/passwd"), undefined);
  assert.equal(index.lookup("ABC"), undefined);
  assert.equal(isShortMessageId("m0123456789"), true);
  assert.equal(isShortMessageId("mZZZZZZZZZZ"), false);
});
