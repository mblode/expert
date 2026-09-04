import { describe, expect, it } from "vitest";
import { identityPrompt, profilePath, skillIndex } from "./profile.ts";

/**
 * The plumbing behind `instructions.md`'s promise. A Bot made at runtime runs
 * the shared template project, so if this block goes missing every one of
 * them is the same agent with an empty brief, which is exactly what shipped
 * before it existed.
 */
describe("the identity block a Bot folds into its own prompt", () => {
  const profile = (o: Record<string, unknown>) => JSON.stringify(o);

  it("names the Bot, its label and its brief", () => {
    const block = identityPrompt(
      "night",
      profile({ description: "Keeps the deploys honest.", name: "Ada", title: "night shift" }),
    );
    expect(block).toContain("You are Ada, night shift.");
    expect(block).toContain("Keeps the deploys honest.");
  });

  it("drops the label when there is none, and still names the memory file", () => {
    const block = identityPrompt("night", profile({ description: "", name: "Ada", title: "" }));
    expect(block).toContain("You are Ada.");
    expect(block).toContain("/workspace/.bots/night/memory/profile.md");
  });

  it("contributes nothing for a Bot nobody has named", () => {
    // A default profile is its own id, no title, no description: the
    // instructions tell the Bot to say its brief is empty and ask, and
    // "You are night." would be noise in front of that.
    expect(identityPrompt("night", profile({ description: "", name: "night", title: "" }))).toBe(
      undefined,
    );
    expect(identityPrompt("night", undefined)).toBe(undefined);
    expect(identityPrompt("night", "{ not json")).toBe(undefined);
  });

  it("keeps a brief this Bot wrote itself inside the hub's caps", () => {
    // The file is under /workspace, so `write_file` reaches it. The hub
    // clamps on the way in and on the way out; this is the third read.
    const block = identityPrompt(
      "night",
      profile({ description: "x".repeat(900), name: "y".repeat(90), title: "" }),
    );
    expect(block).toContain("y".repeat(48));
    expect(block).not.toContain("y".repeat(49));
    expect(block).toContain("x".repeat(500));
    expect(block).not.toContain("x".repeat(501));
  });

  it("reads the file the hub writes", () => {
    // Mirrors BotState.profilePath in apps/hub/src/service/state.ts.
    expect(profilePath("night")).toBe("/workspace/.bots/night/profile.json");
  });
});

/**
 * The other half of what a Bot reads off the box at turn time, and the only
 * reason installing a shared template does anything at all: without it the
 * brief and the skills `Seat.ApplyBotTemplate` writes are files no turn ever
 * opens.
 */
describe("the skills a Bot was given", () => {
  it("lists each one with where it lives and when to open it", () => {
    const block = skillIndex(
      "cos",
      JSON.stringify([
        { id: "calendar", name: "Calendar", use_when: "Use when asked about the day." },
        { id: "voice", name: "Voice", use_when: "" },
      ]),
    );
    expect(block).toContain("Calendar (/workspace/.bots/cos/skills/calendar.md): Use when asked");
    // No trigger line is not a reason to hide the skill: the path is the half
    // that matters, and the model can open it and see.
    expect(block).toContain("Voice (/workspace/.bots/cos/skills/voice.md)");
  });

  it("contributes nothing for a Bot with no skills, and never throws on a bad file", () => {
    expect(skillIndex("cos", "[]")).toBe(undefined);
    expect(skillIndex("cos", undefined)).toBe(undefined);
    expect(skillIndex("cos", "{ not json")).toBe(undefined);
    // An entry with no id is an entry with no file behind it.
    expect(skillIndex("cos", JSON.stringify([{ name: "Nameless" }]))).toBe(undefined);
  });

  /** The bodies are the point of the paths: five of them per turn is the cost. */
  it("never puts a body in the prompt", () => {
    const block = skillIndex(
      "cos",
      JSON.stringify([{ body: "Open the week view.", id: "calendar", name: "Calendar" }]),
    );
    expect(block).not.toContain("Open the week view");
  });
});
