import { describe, expect, it } from "vitest";
import { parseWorkTarget, workReturnTo, workTargetMatches } from "./work-target";

describe("owner work links", () => {
  it("preserves the work destination through login but refuses external redirects", () => {
    expect(workReturnTo("/work?view=code&bot=main")).toBe("/work?view=code&bot=main");
    for (const url of [
      "https://evil.example/work",
      "//evil.example/work",
      "/\\evil.example/work",
      "/api/auth/sign-out",
      ["javascript", "alert(1)"].join(":"),
    ])
      expect(workReturnTo(url)).toBe("/");
  });
  it("does not let a forwarded link select another account's hub", () => {
    const target = parseWorkTarget({
      view: "computer",
      bot: "main",
      hub: "https://one.fly.dev/",
      conversation: "conv_abc",
    });
    expect(target).not.toBeNull();
    expect(workTargetMatches(target!, "https://one.fly.dev")).toBe(true);
    expect(workTargetMatches(target!, "https://two.fly.dev")).toBe(false);
  });
  it("refuses malformed and multi-valued routing context", () => {
    const valid = { view: "code", bot: "main", hub: "https://one.fly.dev" };
    expect(parseWorkTarget({ ...valid, view: ["code", "computer"] })).toBeNull();
    expect(parseWorkTarget({ ...valid, bot: "../main" })).toBeNull();
    expect(parseWorkTarget({ ...valid, conversation: "../secrets" })).toBeNull();
  });
});
