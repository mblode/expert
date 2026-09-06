import { describe, expect, it } from "vitest";

import { cronLabel, parseTemplate, pickSections, sectionsOf, templateView } from "./bot-template";
import type { TemplateSections } from "./bot-template";

const WHOLE = {
  avatar_color: "#0091ff",
  avatar_shape: "diamond",
  description: "Front of house.",
  instructions: "Route work to the specialist.",
  memories: ["the human is in Melbourne"],
  name: "Chief of Staff",
  plugins: [{ auth: "oauth", name: "calendar", url: "https://mcp.example.com/calendar" }],
  routines: [{ cron: "0 20 * * 0-4", id: "morning-brief", prompt: "Write it.", title: "Brief" }],
  skills: [
    { body: "Open the week view.", id: "calendar", name: "Calendar", use_when: "Use when asked." },
  ],
  title: "personal ops",
  version: 1,
};

const ALL: TemplateSections = {
  instructions: true,
  memories: true,
  plugins: true,
  routines: true,
  skills: true,
};

/**
 * This is the control plane's copy of a document authored on someone's
 * computer, so the tests are about what it refuses to pass on: a stored row
 * is rendered on a public page and installed into a stranger's system prompt,
 * and neither end trusts the other with something neither of them wrote.
 */
describe("a stored Bot template", () => {
  it("reads a whole template back as itself", () => {
    const parsed = parseTemplate(WHOLE);
    expect(parsed).toMatchObject({
      avatar_shape: "diamond",
      description: "Front of house.",
      name: "Chief of Staff",
      title: "personal ops",
      version: 1,
    });
    expect(parsed?.skills).toHaveLength(1);
    expect(parsed?.routines[0]?.cron).toBe("0 20 * * 0-4");
  });

  it("is nothing at all without a name, and nothing from a string", () => {
    expect(parseTemplate({ ...WHOLE, name: "   " })).toBeUndefined();
    expect(parseTemplate("a template")).toBeUndefined();
    expect(parseTemplate(null)).toBeUndefined();
  });

  it("clamps the fields that end up in a prompt or a link", () => {
    const parsed = parseTemplate({
      ...WHOLE,
      avatar_color: "url(javascript:alert(1))",
      description: "d".repeat(900),
      instructions: `${"i".repeat(9000)}\u0000\u001B[31m`,
      memories: Array.from({ length: 400 }, (_, i) => `fact ${i}`),
      name: "n".repeat(200),
      plugins: [{ auth: "oauth", name: "evil", url: "data:text/html,<script>alert(1)</script>" }],
      skills: [{ body: "b", id: "../../../etc/passwd", name: "Escape", use_when: "" }],
    });
    expect(parsed?.name).toHaveLength(48);
    expect(parsed?.description).toHaveLength(500);
    expect(parsed?.instructions).toHaveLength(8000);
    expect(parsed?.instructions).not.toContain("\u001B");
    expect(parsed?.memories).toHaveLength(100);
    // A colour lands in an inline style and a plugin address lands in an href.
    expect(parsed?.avatar_color).toMatch(/^#[0-9a-f]{6}$/u);
    expect(parsed?.plugins[0]?.url).toBe("");
    // An id becomes a filename on whichever computer installs this.
    expect(parsed?.skills[0]?.id).toBe("etc-passwd");
  });

  it("drops a routine whose cron nothing here can evaluate", () => {
    const parsed = parseTemplate({
      ...WHOLE,
      routines: [
        { cron: "every morning", id: "a", prompt: "", title: "A" },
        { cron: "0 99 * * *", id: "b", prompt: "", title: "B" },
        { cron: "30 6 * * 1-5", id: "c", prompt: "", title: "C" },
      ],
    });
    expect(parsed?.routines).toHaveLength(1);
    expect(parsed?.routines[0]?.id).toBe("c");
  });

  it("keeps one entry per id, because an id is a file", () => {
    const parsed = parseTemplate({
      ...WHOLE,
      skills: [
        { body: "first", id: "calendar", name: "Calendar", use_when: "" },
        { body: "second", id: "calendar", name: "Calendar again", use_when: "" },
      ],
    });
    expect(parsed?.skills).toHaveLength(1);
    expect(parsed?.skills[0]?.body).toBe("first");
  });

  it("publishes only the sections that were ticked", () => {
    const parsed = parseTemplate(WHOLE)!;
    const kept = pickSections(parsed, { ...ALL, memories: false });
    expect(kept.memories).toEqual([]);
    expect(kept.skills).toHaveLength(1);
    // The identity is not a section: a template is always a Bot.
    expect(kept.name).toBe("Chief of Staff");

    const bare = pickSections(parsed, {
      instructions: false,
      memories: false,
      plugins: false,
      routines: false,
      skills: false,
    });
    expect(bare.instructions).toBe("");
    expect(bare.routines).toEqual([]);
  });

  /**
   * A published document is the record of what its owner chose to share, so
   * reopening the sheet has to read the choices back off it. Reading them
   * from the sheet's own defaults instead is how an update silently drops a
   * section that was deliberately included, or restores one that was not.
   */
  it("says which sections a shared template actually carries", () => {
    const parsed = parseTemplate(WHOLE)!;
    expect(sectionsOf(parsed)).toEqual({
      instructions: true,
      memories: true,
      plugins: true,
      routines: true,
      skills: true,
    });
    // What went out is what comes back: pick, then read, and the answer is
    // the same set of switches.
    const kept = pickSections(parsed, { ...ALL, memories: false, skills: false });
    expect(sectionsOf(kept)).toMatchObject({ memories: false, skills: false, routines: true });
  });

  it("counts what is in it, and says whether the link is live", () => {
    const record = {
      botId: "cos",
      computerId: "vibey",
      createdAt: 1,
      id: "abc",
      installs: 3,
      ownerId: "u1",
      template: parseTemplate(WHOLE)!,
      updatedAt: 2,
    };
    expect(templateView(record)).toMatchObject({
      counts: { memories: 1, plugins: 1, routines: 1, skills: 1 },
      installs: 3,
      published: false,
    });
    expect(templateView({ ...record, publishedAt: 3 }).published).toBe(true);
  });

  /** A wrong English sentence about when a routine runs is worse than the cron. */
  it("says when a routine runs, or shows the cron rather than guessing", () => {
    expect(cronLabel("0 20 * * *")).toBe("Every day at 20:00 UTC");
    expect(cronLabel("30 6 * * 1-5")).toBe(
      "Monday, Tuesday, Wednesday, Thursday, Friday at 06:30 UTC",
    );
    expect(cronLabel("*/5 * * * *")).toBe("*/5 * * * *");
    expect(cronLabel("0 20 1 * *")).toBe("0 20 1 * *");
  });
});
