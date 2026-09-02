// oxlint-disable no-import-node-test, prefer-importing-vitest-globals -- run via node's built-in test runner (tsx --test), not vitest
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createLiveRoster,
  excludeIds,
  formatMemberContext,
  mergeWithOverlay,
  parseParticipants,
  participantFromJid,
  participantsFrom,
  phoneDigits,
  phonesMatch,
  samePerson,
  toE164,
} from "./live-members.ts";
import type { Member } from "./members.ts";

const overlay = (partial: Partial<Member> & Pick<Member, "name" | "phone">): Member => ({
  tags: partial.tags ?? [],
  ...partial,
});

test("phoneDigits strips non-digits", () => {
  assert.equal(phoneDigits("+61 478 144 441"), "61478144441");
  assert.equal(phoneDigits("61478144441@s.whatsapp.net"), "61478144441");
  assert.equal(phoneDigits(""), "");
});

test("phonesMatch is AU-tolerant", () => {
  assert.equal(phonesMatch("+61478144441", "61478144441"), true);
  assert.equal(phonesMatch("0478144441", "61478144441"), true);
  assert.equal(phonesMatch("61478144441", "478144441"), true);
  assert.equal(phonesMatch("61478144441", "61400000000"), false);
  assert.equal(phonesMatch("", "61478144441"), false);
});

test("samePerson matches on phone or lid, not a mixed miss", () => {
  assert.equal(samePerson({ phone: "61478144441" }, { lid: "9", phone: "+61478144441" }), true);
  assert.equal(samePerson({ lid: "216543" }, { lid: "216543" }), true);
  assert.equal(samePerson({ phone: "61478144441" }, { lid: "216543" }), false);
});

test("toE164 prefixes digits", () => {
  assert.equal(toE164("61478144441"), "+61478144441");
  assert.equal(toE164("+61478144441"), "+61478144441");
  assert.equal(toE164(""), "");
});

test("parseParticipants drops junk and keeps valid rows", () => {
  assert.deepEqual(parseParticipants(null), {});
  assert.deepEqual(parseParticipants("nope"), {});
  assert.deepEqual(parseParticipants([]), {});
  assert.deepEqual(
    parseParticipants({
      "g@g.us": [
        { lid: "1", name: "Finlay", phone: "+61411111111" },
        { name: "nobody" },
        "nope",
        { lid: "2" },
      ],
      skip: { phone: "1" },
    }),
    {
      "g@g.us": [{ lid: "1", name: "Finlay", phone: "61411111111" }, { lid: "2" }],
    },
  );
});

test("participantFromJid reads both addressing forms", () => {
  assert.deepEqual(participantFromJid("61411111111@s.whatsapp.net"), {
    phone: "61411111111",
  });
  assert.deepEqual(participantFromJid("216543@lid"), { lid: "216543" });
  assert.equal(participantFromJid("1203@g.us"), null);
  assert.equal(participantFromJid(""), null);
});

test("participantsFrom keeps one-sided metadata and raw JID strings", () => {
  assert.deepEqual(
    participantsFrom([
      {
        id: "216543@lid",
        name: "Finlay",
        phoneNumber: "61411111111@s.whatsapp.net",
      },
      { id: "333@lid" },
      { id: "61400000000@s.whatsapp.net" },
      "61422222222@s.whatsapp.net",
      "999@lid",
      null,
    ]),
    [
      { lid: "216543", name: "Finlay", phone: "61411111111" },
      { lid: "333" },
      { phone: "61400000000" },
      { phone: "61422222222" },
      { lid: "999" },
    ],
  );
  assert.deepEqual(participantsFrom(null), []);
});

test("excludeIds drops the bot by phone or lid", () => {
  const people = [
    { lid: "botlid", phone: "61494718128" },
    { name: "Finlay", phone: "61411111111" },
  ];
  assert.deepEqual(excludeIds(people, new Set(["61494718128"])), [
    { name: "Finlay", phone: "61411111111" },
  ]);
  assert.deepEqual(excludeIds(people, new Set(["botlid"])), [
    { name: "Finlay", phone: "61411111111" },
  ]);
});

test("mergeWithOverlay applies git profiles and stubs unidentified joiners", () => {
  const merged = mergeWithOverlay(
    [
      { lid: "1", name: "Marcus", phone: "61408461216" },
      { lid: "2", name: "Finlay", phone: "61411111111" },
      { lid: "3" },
    ],
    [
      overlay({
        inChat: ["MCP"],
        linkedin: "https://linkedin.com/in/marcus",
        name: "Marcus Schappi",
        phone: "+61408461216",
        tags: ["mcp"],
      }),
    ],
  );
  assert.equal(merged.length, 3);
  assert.equal(merged[1]?.name, "Marcus Schappi");
  assert.equal(merged[1]?.linkedin, "https://linkedin.com/in/marcus");
  assert.equal(merged[1]?.lid, "1");
  assert.deepEqual(
    merged.find((m) => m.name === "Finlay"),
    {
      lid: "2",
      name: "Finlay",
      phone: "+61411111111",
      tags: ["unidentified"],
    },
  );
  assert.equal(merged.find((m) => m.lid === "3")?.name, "Unknown member");
  assert.equal(merged.find((m) => m.lid === "3")?.tags[0], "unidentified");
  // Overlay-only people (left the group) are omitted.
  assert.equal(
    merged.some((m) => m.name === "Marcus Schappi"),
    true,
  );
});

test("mergeWithOverlay omits a git profile whose phone is not live", () => {
  const merged = mergeWithOverlay(
    [{ name: "Finlay", phone: "61411111111" }],
    [overlay({ name: "Geoff Huntley", phone: "+61400000000", tags: [] })],
  );
  assert.deepEqual(
    merged.map((m) => m.name),
    ["Finlay"],
  );
});

test("formatMemberContext stars unidentified names", () => {
  const block = formatMemberContext([
    overlay({ name: "Marcus Schappi", phone: "+61408461216", tags: ["mcp"] }),
    overlay({ name: "Finlay", phone: "+61411111111", tags: ["unidentified"] }),
  ]);
  assert.match(block ?? "", /Current WhatsApp group members \(2;/u);
  assert.match(block ?? "", /Marcus Schappi/u);
  assert.match(block ?? "", /Finlay\*/u);
  assert.equal(formatMemberContext([]), null);
});

test("live roster persist snapshot, add, remove, and name touch", () => {
  const live = createLiveRoster();
  assert.equal(live.ready(), false);
  assert.deepEqual(live.all(), []);

  live.load({
    "g@g.us": [{ lid: "1", name: "Marcus", phone: "61408461216" }],
  });
  assert.equal(live.ready(), true);
  assert.deepEqual(live.phones(), ["61408461216"]);
  assert.deepEqual(live.lids(), ["1"]);

  live.upsert("g@g.us", { lid: "2", name: "Finlay", phone: "61411111111" });
  assert.equal(live.all().length, 2);
  assert.equal(live.dirty(), true);

  live.remove("g@g.us", { phone: "61408461216" });
  assert.deepEqual(
    live.all().map((p) => p.name),
    ["Finlay"],
  );

  live.touchName("61411111111", "2", "Finlay Smith");
  assert.equal(live.all()[0]?.name, "Finlay Smith");

  live.clearDirty();
  assert.equal(live.dirty(), false);
  assert.deepEqual(live.snapshot(), {
    "g@g.us": [{ lid: "2", name: "Finlay Smith", phone: "61411111111" }],
  });
});

test("replaceGroup is the seed path and markSeeded makes an empty room ready", () => {
  const live = createLiveRoster();
  live.replaceGroup("g@g.us", [
    { lid: "1", phone: "61408461216" },
    { lid: "1", name: "Marcus", phone: "+61408461216" },
    { lid: "bot", phone: "61494718128" },
  ]);
  assert.equal(live.all().length, 2);
  live.replaceGroup(
    "g@g.us",
    excludeIds(live.snapshot()["g@g.us"] ?? [], new Set(["61494718128"])),
  );
  assert.deepEqual(live.phones(), ["61408461216"]);

  const empty = createLiveRoster();
  empty.replaceGroup("g@g.us", []);
  empty.markSeeded();
  assert.equal(empty.ready(), true);
  assert.deepEqual(empty.all(), []);
});

test("upsert merges a lid-only sighting onto a later phone", () => {
  const live = createLiveRoster();
  live.upsert("g@g.us", { lid: "9", name: "Joiner" });
  live.upsert("g@g.us", { lid: "9", phone: "61422222222" });
  assert.deepEqual(live.all(), [{ lid: "9", name: "Joiner", phone: "61422222222" }]);
});
