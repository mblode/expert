// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import { allGroups, listedGroups } from "./groups.ts";
import { createDailyCounter } from "./media-send.ts";
import {
  authoriseEnvelope,
  parseSendEnvelope,
  sanitiseFilename,
  MAX_MEDIA_ITEMS,
} from "./send-envelope.ts";
import type { EnvelopeLimits, SendEnvelope } from "./send-envelope.ts";

const GROUP = "1@g.us";
const DM = "61400000000@s.whatsapp.net";

const gate = (overrides = {}) => ({
  groups: allGroups,
  isMember: () => true,
  isOwnerJid: () => false,
  maintainerJid: "",
  ...overrides,
});

const limits = (writes = 100, media = 20): EnvelopeLimits => ({
  media: createDailyCounter(media),
  writes: createDailyCounter(writes),
});

const envelope = (over: Partial<SendEnvelope> = {}): SendEnvelope => ({ jid: GROUP, ...over });

// ---- parsing --------------------------------------------------------------

test("parseSendEnvelope requires a jid and at least one verb", () => {
  assert.deepEqual(parseSendEnvelope({}), { error: "jid required" });
  assert.deepEqual(parseSendEnvelope({ jid: GROUP }), {
    error: "envelope must carry text, react or media",
  });
  assert.deepEqual(parseSendEnvelope({ jid: " 1@g.us ", text: "  hi  " }), {
    envelope: { jid: GROUP, text: "hi" },
  });
});

test("parseSendEnvelope keeps reply_to and drops unknown keys", () => {
  const parsed = parseSendEnvelope({
    jid: DM,
    nonsense: { deeply: "nested" },
    reply_to: "m0123456789",
    text: "on it",
  });
  assert.deepEqual(parsed, { envelope: { jid: DM, reply_to: "m0123456789", text: "on it" } });
  assert.deepEqual(parseSendEnvelope({ jid: DM, reply_to: "   ", text: "x" }), {
    error: "reply_to must be a message id",
  });
});

test("parseSendEnvelope validates a reaction down to one emoji", () => {
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, react: { emoji: "🔥", to: "m0123456789" } }), {
    envelope: { jid: GROUP, react: { emoji: "🔥", to: "m0123456789" } },
  });
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, react: { emoji: "🔥" } }), {
    error: "react.to required",
  });
  // Empty is WhatsApp's "remove the reaction", a verb this envelope does not offer.
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, react: { emoji: "  ", to: "m1" } }), {
    error: "react.emoji required",
  });
  // A reaction field is not a second text field.
  assert.deepEqual(
    parseSendEnvelope({ jid: GROUP, react: { emoji: "a whole sentence", to: "m1" } }),
    { error: "react.emoji must be a single emoji" },
  );
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, react: "🔥" }), {
    error: "react must be an object",
  });
});

test("parseSendEnvelope validates media kind, mime and base64", () => {
  const ok = parseSendEnvelope({
    jid: GROUP,
    media: [
      { base64: "aGk=", caption: " a chart ", kind: "image", mime: "image/png" },
      { base64: "aGk=", filename: "notes.pdf", kind: "document", mime: "application/pdf" },
    ],
  });
  assert.deepEqual(ok, {
    envelope: {
      jid: GROUP,
      media: [
        { base64: "aGk=", caption: "a chart", kind: "image", mime: "image/png" },
        { base64: "aGk=", filename: "notes.pdf", kind: "document", mime: "application/pdf" },
      ],
    },
  });
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, media: [{ base64: "aGk=", kind: "gif" }] }), {
    error: 'media[0].kind must be "image" or "document"',
  });
  assert.deepEqual(
    parseSendEnvelope({
      jid: GROUP,
      media: [{ base64: "aGk=", kind: "image", mime: "text/plain" }],
    }),
    { error: "media[0].mime must be an image/* type for an image" },
  );
  assert.deepEqual(
    parseSendEnvelope({ jid: GROUP, media: [{ kind: "image", mime: "image/png" }] }),
    { error: "media[0].base64 required" },
  );
  // A document with no name lands in the chat as an unidentifiable file.
  assert.deepEqual(
    parseSendEnvelope({
      jid: GROUP,
      media: [{ base64: "aGk=", kind: "document", mime: "application/pdf" }],
    }),
    { error: "media[0].filename required for a document" },
  );
});

test("parseSendEnvelope caps how many files one envelope carries", () => {
  const item = { base64: "aGk=", kind: "image", mime: "image/png" };
  const many = Array.from({ length: MAX_MEDIA_ITEMS + 1 }, () => item);
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, media: many }), {
    error: `media accepts at most ${MAX_MEDIA_ITEMS} items`,
  });
  assert.deepEqual(parseSendEnvelope({ jid: GROUP, media: "aGk=" }), {
    error: "media must be an array",
  });
});

test("sanitiseFilename strips paths, control bytes and leading dots", () => {
  assert.equal(sanitiseFilename("../../etc/passwd"), "_.._etc_passwd");
  assert.equal(sanitiseFilename("q3\u0000\u001B.pdf"), "q3.pdf");
  assert.equal(sanitiseFilename("x".repeat(300)).length, 120);
});

// ---- policy ---------------------------------------------------------------

test("authoriseEnvelope refuses a target the bot would not otherwise write to", () => {
  const decision = authoriseEnvelope(
    envelope({ jid: "9@g.us", media: [{ base64: "aGk=", kind: "image", mime: "image/png" }] }),
    {},
    gate({ groups: listedGroups([GROUP]) }),
    limits(),
  );
  assert.deepEqual(decision, { ok: false, reason: "jid not allowlisted for sends" });
});

test("authoriseEnvelope refuses an id it cannot resolve or that is in another chat", () => {
  assert.deepEqual(
    authoriseEnvelope(envelope({ reply_to: "m0123456789", text: "hi" }), {}, gate(), limits()),
    { ok: false, reason: "unknown reply_to message id" },
  );
  assert.deepEqual(
    authoriseEnvelope(
      envelope({ reply_to: "m0123456789", text: "hi" }),
      { replyToJid: "2@g.us" },
      gate(),
      limits(),
    ),
    { ok: false, reason: "reply_to is a message in another chat" },
  );
  assert.deepEqual(
    authoriseEnvelope(
      envelope({ react: { emoji: "🔥", to: "m0123456789" } }),
      { reactToJid: "2@g.us" },
      gate(),
      limits(),
    ),
    { ok: false, reason: "react.to is a message in another chat" },
  );
});

// The invariant POST /send protects in code (a Bot never posts to a group on a
// timer) has to survive the envelope, or it is one endpoint name away from
// being bypassed. Anchored text is a reply to something a member said; bare
// text into a group is the broadcast /send refuses.
test("authoriseEnvelope refuses unanchored text into a group and allows a quoted reply", () => {
  assert.deepEqual(authoriseEnvelope(envelope({ text: "morning all" }), {}, gate(), limits()), {
    ok: false,
    reason: "text into a group must quote a message in it (reply_to)",
  });
  assert.deepEqual(
    authoriseEnvelope(
      envelope({ reply_to: "m0123456789", text: "morning all" }),
      { replyToJid: GROUP },
      gate(),
      limits(),
    ),
    { ok: true },
  );
  // A DM is unaffected: a digest still goes out unanchored.
  assert.deepEqual(
    authoriseEnvelope(envelope({ jid: DM, text: "your recap" }), {}, gate(), limits()),
    { ok: true },
  );
  // So is an image into a group, which /send-media already permitted.
  assert.deepEqual(
    authoriseEnvelope(
      envelope({ media: [{ base64: "aGk=", kind: "image", mime: "image/png" }] }),
      {},
      gate(),
      limits(),
    ),
    { ok: true },
  );
});

test("every verb spends the write budget, reactions included", () => {
  const budget = limits(2);
  const react = envelope({ react: { emoji: "🔥", to: "m0123456789" } });
  const targets = { reactToJid: GROUP };
  assert.deepEqual(authoriseEnvelope(react, targets, gate(), budget), { ok: true });
  assert.deepEqual(authoriseEnvelope(react, targets, gate(), budget), { ok: true });
  assert.deepEqual(authoriseEnvelope(react, targets, gate(), budget), {
    ok: false,
    reason: "daily send limit reached for this chat",
  });
});

test("media spends one image slot per file, all or nothing", () => {
  const budget = limits(100, 2);
  const three = envelope({
    media: Array.from({ length: 3 }, () => ({
      base64: "aGk=",
      kind: "image" as const,
      mime: "image/png",
    })),
  });
  assert.deepEqual(authoriseEnvelope(three, {}, gate(), budget), {
    ok: false,
    reason: "daily image limit reached for this chat",
  });
  // The refusal spent nothing, so two still fit.
  const two = envelope({
    media: Array.from({ length: 2 }, () => ({
      base64: "aGk=",
      kind: "image" as const,
      mime: "image/png",
    })),
  });
  assert.deepEqual(authoriseEnvelope(two, {}, gate(), budget), { ok: true });
});

test("a refused envelope never spends a slot", () => {
  const budget = limits(1, 1);
  assert.deepEqual(
    authoriseEnvelope(
      envelope({ jid: "9@g.us", text: "hi" }),
      {},
      gate({ groups: listedGroups([GROUP]) }),
      budget,
    ),
    { ok: false, reason: "jid not allowlisted for sends" },
  );
  assert.deepEqual(
    authoriseEnvelope(envelope({ jid: DM, text: "still here" }), {}, gate(), budget),
    { ok: true },
  );
});
