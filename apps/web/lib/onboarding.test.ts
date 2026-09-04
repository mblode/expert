import { describe, expect, it } from "vitest";

import { keepTools, signInPrompt, toolLabel } from "./onboarding";

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
