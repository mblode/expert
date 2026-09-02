// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Member } from "./members.ts";
import {
  composeMentionLookup,
  lidPairsFrom,
  memberNameLookup,
  resolveMentions,
} from "./mentions.ts";

const roster: Member[] = [
  { name: "John Croucher", phone: "+61408461216", tags: [] },
  { name: "Cara Davies", phone: "+61421069552", tags: [] },
  { name: "Luca Bonelli", phone: "+61478144441", tags: [] },
];
const rosterLookup = memberNameLookup(roster);

test("memberNameLookup resolves bare mention digits against E.164 roster phones", () => {
  assert.equal(rosterLookup("61408461216"), "John Croucher");
  assert.equal(rosterLookup("61421069552"), "Cara Davies");
  assert.equal(rosterLookup("15550000000"), undefined);
});

// The screenshot regression: "@Luca Bonelli" arrives as an opaque @lid the
// roster (keyed by phone) can't resolve alone. composeMentionLookup bridges it
// via the learned lid->phone pairing.
const LUCA_LID = "216543000111";
const BOT = { botIds: new Set(["botlid", "15551234567"]), botName: "Vibey" };

test("composeMentionLookup resolves a member's @lid via the learned lid->phone map", () => {
  const lookup = composeMentionLookup({
    ...BOT,
    lidName: () => undefined,
    lidPhone: (u) => (u === LUCA_LID ? "61478144441" : undefined),
    roster: rosterLookup,
  });
  assert.equal(lookup(LUCA_LID), "Luca Bonelli");
});

test("composeMentionLookup still resolves a phone-form mention directly", () => {
  const lookup = composeMentionLookup({ ...BOT, roster: rosterLookup });
  assert.equal(lookup("61408461216"), "John Croucher");
});

test("composeMentionLookup maps the bot's own ids to its name", () => {
  const lookup = composeMentionLookup({ ...BOT, roster: rosterLookup });
  assert.equal(lookup("botlid"), "Vibey");
  assert.equal(lookup("15551234567"), "Vibey");
});

test("composeMentionLookup prefers the roster over a conflicting pushName", () => {
  const lookup = composeMentionLookup({
    ...BOT,
    lidName: () => "lucaaa",
    lidPhone: () => "61478144441",
    roster: rosterLookup,
  });
  assert.equal(lookup(LUCA_LID), "Luca Bonelli");
});

test("composeMentionLookup falls back to pushName for a non-member lid", () => {
  const lookup = composeMentionLookup({
    ...BOT,
    lidName: (u) => (u === "guest99" ? "Guesty" : undefined),
    lidPhone: () => undefined,
    roster: rosterLookup,
  });
  assert.equal(lookup("guest99"), "Guesty");
});

test("composeMentionLookup returns undefined for an unknown lid (left raw)", () => {
  const lookup = composeMentionLookup({
    ...BOT,
    lidName: () => undefined,
    lidPhone: () => undefined,
    roster: rosterLookup,
  });
  assert.equal(lookup("nobody123"), undefined);
});

test("composeMentionLookup end-to-end: resolveMentions names a lid-tagged member", () => {
  const lookup = composeMentionLookup({
    ...BOT,
    lidPhone: (u) => (u === LUCA_LID ? "61478144441" : undefined),
    roster: rosterLookup,
  });
  // "@<botlid> tell me about @<luca-lid>" with both in mentionedJid, bot stripped.
  assert.equal(
    resolveMentions(
      `@botlid tell me about @${LUCA_LID}`,
      ["botlid@lid", `${LUCA_LID}@lid`],
      lookup,
      { strip: new Set(["botlid"]) },
    ).trim(),
    "tell me about @Luca Bonelli",
  );
});

test("resolveMentions replaces a phone mention with the roster name", () => {
  assert.equal(
    resolveMentions("have you met @61408461216?", ["61408461216@s.whatsapp.net"], rosterLookup),
    "have you met @John Croucher?",
  );
});

const lidLookup = (u: string) => (u === "132745292447" ? "Ben Friebe" : undefined);

test("resolveMentions resolves an opaque @lid mention via the injected lookup", () => {
  assert.equal(
    resolveMentions("@132745292447 more ASCII art please", ["132745292447@lid"], lidLookup),
    "@Ben Friebe more ASCII art please",
  );
});

test("resolveMentions leaves an unresolvable token as-is (raw id beats a hole)", () => {
  assert.equal(resolveMentions("ask @99999", ["99999@lid"], rosterLookup), "ask @99999");
});

test("resolveMentions removes tokens in the strip set (the bot's own ids)", () => {
  assert.equal(
    resolveMentions(
      "@98765 how many times have I recommended @61408461216 ?",
      ["98765@lid", "61408461216@s.whatsapp.net"],
      rosterLookup,
      { strip: new Set(["98765"]) },
    ).trim(),
    "how many times have I recommended @John Croucher ?",
  );
});

test("resolveMentions only touches tokens backed by a mentioned JID", () => {
  // "@61408461216" appears in the text but is not in mentionedJid: untouched.
  assert.equal(
    resolveMentions("see @61408461216", ["55555@lid"], rosterLookup),
    "see @61408461216",
  );
});

const prefixLookup = (u: string) => ({ "614": "Shorty", "61408461216": "John Croucher" })[u];

test("resolveMentions is prefix-safe when one user-part prefixes another", () => {
  assert.equal(
    resolveMentions(
      "@614 and @61408461216",
      ["614@lid", "61408461216@s.whatsapp.net"],
      prefixLookup,
    ),
    "@Shorty and @John Croucher",
  );
});

test("resolveMentions resolves every occurrence of a repeated token", () => {
  assert.equal(
    resolveMentions(
      "@61408461216 then @61408461216 again",
      ["61408461216@s.whatsapp.net"],
      rosterLookup,
    ),
    "@John Croucher then @John Croucher again",
  );
});

test("resolveMentions handles device suffixes and duplicate mentioned JIDs", () => {
  assert.equal(
    resolveMentions(
      "ping @61421069552",
      ["61421069552:12@s.whatsapp.net", "61421069552@s.whatsapp.net"],
      rosterLookup,
    ),
    "ping @Cara Davies",
  );
});

test("resolveMentions is a no-op without text or mentions", () => {
  assert.equal(resolveMentions("", ["1@lid"], rosterLookup), "");
  assert.equal(resolveMentions("hi there", null, rosterLookup), "hi there");
  assert.equal(resolveMentions("hi there", [], rosterLookup), "hi there");
});

const dollarLookup = () => "A$AP";

test("resolveMentions treats a $ in a resolved name literally", () => {
  assert.equal(resolveMentions("yo @777", ["777@lid"], dollarLookup), "yo @A$AP");
});

test("lidPairsFrom pairs a lid-addressed group participant (id=@lid, phoneNumber=PN)", () => {
  assert.deepEqual(
    lidPairsFrom([{ id: "216543000111@lid", phoneNumber: "61478144441@s.whatsapp.net" }]),
    [{ lid: "216543000111", phone: "61478144441" }],
  );
});

test("lidPairsFrom pairs a pn-addressed group participant (id=PN, lid=@lid)", () => {
  assert.deepEqual(lidPairsFrom([{ id: "61478144441@s.whatsapp.net", lid: "216543000111@lid" }]), [
    { lid: "216543000111", phone: "61478144441" },
  ]);
});

test("lidPairsFrom carries a contact's name (name preferred, notify fallback)", () => {
  assert.deepEqual(
    lidPairsFrom([
      {
        id: "111@lid",
        name: "Luca Bonelli",
        phoneNumber: "61478144441@s.whatsapp.net",
      },
      {
        id: "222@lid",
        notify: "Guesty",
        phoneNumber: "15550001111@s.whatsapp.net",
      },
    ]),
    [
      { lid: "111", name: "Luca Bonelli", phone: "61478144441" },
      { lid: "222", name: "Guesty", phone: "15550001111" },
    ],
  );
});

test("lidPairsFrom skips entries missing either half and tolerates junk", () => {
  assert.deepEqual(
    lidPairsFrom([
      // lid id but no phone: server didn't populate phone_number.
      { id: "333@lid" },
      // pn id but no lid.
      { id: "61400000000@s.whatsapp.net" },
      // unknown domain.
      { id: "444@g.us", phoneNumber: "61400000000@s.whatsapp.net" },
      null,
      undefined,
      {},
    ]),
    [],
  );
  assert.deepEqual(lidPairsFrom(null), []);
  assert.deepEqual(lidPairsFrom(), []);
});
