import { describe, expect, it } from "vitest";

import type { BotProfile, Screen, WorkConversation } from "./seat";
import { threadPreview, threadRows, threadTime, threadTitle } from "./threads";

const profiles: Record<string, BotProfile> = {
  main: { name: "Vibey" } as BotProfile,
};

const screens = [{ bot_id: "main", display: 1, state: "AGENT" }] as Screen[];

function conversation(over: Partial<WorkConversation>): WorkConversation {
  return {
    bot: "main",
    id: "conv_1",
    last_seq: 1,
    route: { kind: "seat" },
    updated_at: "2026-09-07T00:00:00.000Z",
    ...over,
  };
}

describe("thread titles", () => {
  it("names a DM after the person, and a group after the people in it", () => {
    const dm = conversation({
      participants: [
        { bot: "main", kind: "bot" },
        { display_name: "Matthew Blode", kind: "human", ref: "61456455551@s.whatsapp.net" },
      ],
      route: { acct: "vcmc", jid: "61456455551@s.whatsapp.net", kind: "whatsapp" },
    });
    expect(threadTitle(dm, profiles)).toBe("Matthew Blode");

    // A group has no name here: WhatsApp knows its subject and the bridge
    // does not send it, so the people who have spoken are the honest title.
    const group = conversation({
      participants: [
        { bot: "main", kind: "bot" },
        { display_name: "Adam", kind: "human", ref: "1@s.whatsapp.net" },
        { display_name: "Ben", kind: "human", ref: "2@s.whatsapp.net" },
      ],
      route: { acct: "vcmc", jid: "1203@g.us", kind: "whatsapp" },
    });
    expect(threadTitle(group, profiles)).toBe("Adam, Ben");
  });

  it("falls back to the number, never to the routing token", () => {
    const dm = conversation({
      participants: [{ kind: "human", ref: "61456455551@s.whatsapp.net" }],
      route: { acct: "vcmc", jid: "61456455551@s.whatsapp.net", kind: "whatsapp" },
    });
    expect(threadTitle(dm, profiles)).toBe("+61456455551");
    // Nobody has spoken in it yet, so there is nobody to name it after.
    expect(
      threadTitle(conversation({ route: { jid: "1203@g.us", kind: "whatsapp" } }), profiles),
    ).toBe("WhatsApp group");
  });

  it("names the Bot's own thread after the Bot", () => {
    expect(threadTitle(conversation({}), profiles)).toBe("Vibey");
    expect(threadTitle(conversation({ bot: "night" }), profiles)).toBe("night");
  });
});

describe("thread previews", () => {
  const preview = { at: 1, author: { kind: "human", ref: "1@s.whatsapp.net" }, text: "hello" };

  it("names the speaker in a group and not in a DM", () => {
    const participants = [
      { bot: "main", kind: "bot" },
      { display_name: "Adam", kind: "human", ref: "1@s.whatsapp.net" },
    ];
    const group = conversation({
      participants,
      preview,
      route: { jid: "1203@g.us", kind: "whatsapp" },
    });
    expect(threadPreview(group)).toBe("Adam: hello");

    // In a DM there is only one person it could be, so the name is noise.
    const dm = conversation({
      participants,
      preview,
      route: { jid: "1@s.whatsapp.net", kind: "whatsapp" },
    });
    expect(threadPreview(dm)).toBe("hello");
  });

  it("never prefixes the Bot's own voice", () => {
    const group = conversation({
      preview: { at: 1, author: { bot: "main", kind: "bot" }, text: "on it" },
      route: { jid: "1203@g.us", kind: "whatsapp" },
    });
    expect(threadPreview(group)).toBe("on it");
  });

  it("has nothing to say about a thread with nothing in it", () => {
    expect(threadPreview(conversation({}))).toBeUndefined();
  });
});

describe("thread rows", () => {
  it("sorts by the tail and keeps a Bot nobody has spoken to", () => {
    const rows = threadRows(
      [
        conversation({ id: "seat", preview: { at: 100, author: { kind: "system" }, text: "old" } }),
        conversation({
          id: "group",
          preview: { at: 900, author: { bot: "main", kind: "bot" }, text: "new" },
          route: { jid: "1203@g.us", kind: "whatsapp" },
        }),
      ],
      [...screens, { bot_id: "night", display: 2, state: "AGENT" } as Screen],
      profiles,
    );
    expect(rows.map((r) => r.key)).toEqual(["group", "seat", "bot:night"]);
    // A Bot made a minute ago has no conversation until it is spoken to, and
    // a list that dropped it would lose the Bot you just made.
    expect(rows[2]).toMatchObject({ botId: "night", display: 2, live: true, title: "night" });
    // Only the Bot's own thread can be spoken into from here.
    expect(rows.map((r) => r.live)).toEqual([false, true, true]);
    // Every row carries the screen its Bot is on, whatever route it is.
    expect(rows[0]?.display).toBe(1);
  });
});

describe("thread time", () => {
  const now = Date.parse("2026-09-07T09:00:00");

  it("says the time today, the weekday this week, and the date before that", () => {
    expect(threadTime(Date.parse("2026-09-07T07:51:00"), now)).toMatch(/7:51/);
    expect(threadTime(Date.parse("2026-09-06T07:51:00"), now)).toBe("Yesterday");
    expect(threadTime(Date.parse("2026-09-03T07:51:00"), now)).toBe("Thursday");
    expect(threadTime(Date.parse("2026-08-30T07:51:00"), now)).toMatch(/2026/);
    // A thread with nothing in it has no time, and shows none.
    expect(threadTime(undefined, now)).toBe("");
  });
});
