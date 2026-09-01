import { describe, expect, it } from "vitest";
import { toKeysym } from "../src/desk/docker.ts";

describe("toKeysym", () => {
  it("lowercases a bare letter so a chord is case-insensitive", () => {
    // Regression: ["CTRL","L"] used to reach xdotool as ctrl+L, which X reads
    // as ctrl+shift+l — the agent asked for the address bar and got nothing.
    expect(toKeysym("L")).toBe("l");
    expect(toKeysym("A")).toBe("a");
    expect(toKeysym("l")).toBe("l");
  });

  it("maps modifier and named keys regardless of case", () => {
    expect(toKeysym("CTRL")).toBe("ctrl");
    expect(toKeysym("Enter")).toBe("Return");
    expect(toKeysym("RETURN")).toBe("Return");
    expect(toKeysym("pageup")).toBe("Page_Up");
  });

  it("passes an unlisted multi-character keysym through untouched", () => {
    expect(toKeysym("F5")).toBe("F5");
    expect(toKeysym("Page_Down")).toBe("Page_Down");
  });
});
