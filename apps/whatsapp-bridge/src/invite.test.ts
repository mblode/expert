// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildInviteMessage, inviteDedupKey } from "./invite.ts";

test("inviteDedupKey normalises name case/whitespace and phone punctuation", () => {
  const a = inviteDedupKey({
    fullName: "  Jane   DOE ",
    phone: "+61 400 000 000",
  });
  const b = inviteDedupKey({ fullName: "jane doe", phone: "(61) 400-000-000" });
  assert.equal(a, b);
});

test("inviteDedupKey distinguishes different people", () => {
  assert.notEqual(
    inviteDedupKey({ fullName: "Jane Doe", phone: "+61400000000" }),
    inviteDedupKey({ fullName: "John Doe", phone: "+61400000000" }),
  );
});

test("buildInviteMessage includes name and phone and the requester", () => {
  const text = buildInviteMessage(
    {
      fullName: "Jane Doe",
      phone: "+61 400 000 000",
      requestedBy: "Josh Peak",
    },
    "vibey",
  );
  assert.match(text, /^New member invite via @vibey/u);
  assert.match(text, /From: Josh Peak/u);
  assert.match(text, /Name: Jane Doe/u);
  assert.match(text, /Phone: \+61 400 000 000/u);
});

test("buildInviteMessage adds optional email, LinkedIn and note when present", () => {
  const text = buildInviteMessage(
    {
      email: "jane@example.com",
      fullName: "Jane Doe",
      linkedIn: "https://linkedin.com/in/janedoe",
      note: "Ships with Claude Code, keen on agents.",
      phone: "+61400000000",
    },
    "vibey",
  );
  assert.match(text, /Email: jane@example\.com/u);
  assert.match(text, /LinkedIn: https:\/\/linkedin\.com\/in\/janedoe/u);
  assert.match(text, /Ships with Claude Code/u);
});

test("buildInviteMessage omits absent optionals and falls back to 'someone'", () => {
  const text = buildInviteMessage({ fullName: "Jane Doe", phone: "+61400000000" }, "vibey");
  assert.match(text, /From: someone/u);
  assert.doesNotMatch(text, /Email:/u);
  assert.doesNotMatch(text, /LinkedIn:/u);
});
