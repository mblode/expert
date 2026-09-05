import { describe, expect, it } from "vitest";

import { keepTools, signInPrompt, toolLabel } from "./onboarding";
import { completeOnboarding, readOnboarding } from "./onboarding-store";

describe("keepTools", () => {
  it("keeps only ids this build draws", () => {
    expect(keepTools(["slack", "myspace", "github"])).toEqual(["slack", "github"]);
  });

  it("answers in catalog order, whatever order they were tapped", () => {
    // Google is the first tile and Canva the last, so a tap order of
    // Canva-then-Google is the one that proves the order is the catalog's.
    expect(keepTools(["canva", "google"])).toEqual(["google", "canva"]);
  });

  it("drops repeats", () => {
    expect(keepTools(["notion", "notion"])).toEqual(["notion"]);
  });

  it("treats anything that is not a list of strings as no answer", () => {
    expect(keepTools(undefined)).toEqual([]);
    expect(keepTools("slack")).toEqual([]);
    expect(keepTools([1, null, { id: "slack" }])).toEqual([]);
  });
});

describe("the first task a pick turns into", () => {
  it("names the tool and asks for the seat rather than the password", () => {
    const prompt = signInPrompt("xero");
    expect(prompt).toContain(toolLabel("xero"));
    expect(prompt).toContain("seat");
  });
});

/**
 * The first run is read in the root server component, so anything it throws
 * is the whole page for anyone signed in. It threw for real: `db:push` is a
 * command somebody runs rather than part of the deploy, so the table was not
 * there and hello.expert answered a minified React #441 to its owner while
 * signed-out visitors saw the marketing page as normal.
 */
describe("reading the first run on a database that has never seen it", () => {
  it("makes the table rather than throwing into the page", async () => {
    await expect(readOnboarding("nobody-yet")).resolves.toEqual({ done: false, tools: [] });
  });

  it("remembers an answer, and reads it back filtered", async () => {
    await completeOnboarding("someone", ["email", "not-a-tool"]);
    const state = await readOnboarding("someone");
    expect(state.done).toBe(true);
    expect(state.tools).not.toContain("not-a-tool");
  });
});
