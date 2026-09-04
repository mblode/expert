import { describe, expect, it } from "vitest";
import { identityPrompt, profilePath } from "./profile.ts";

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
