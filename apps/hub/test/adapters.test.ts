import { describe, expect, it } from "vitest";
import { DISPLAY } from "@computer/shared";
import { fromClaude, fromGemini, geminiX, geminiY } from "../src/service/adapters.ts";

describe("adapters", () => {
  it("maps Claude left_click → click and keeps zoom", () => {
    const [click, zoom] = fromClaude([
      { type: "left_click", x: 10, y: 20 },
      { type: "zoom", x: 0, y: 0, w: 100, h: 80 },
    ]);
    expect(click).toMatchObject({ type: "click", button: "left", x: 10, y: 20 });
    expect(zoom).toMatchObject({ type: "zoom", w: 100, h: 80 });
  });

  it("divides Gemini 0–999 into 1280×800 and never emits 0–999 as native", () => {
    expect(geminiX(0)).toBe(0);
    expect(geminiX(999)).toBe(DISPLAY.width - 1);
    expect(geminiY(999)).toBe(DISPLAY.height - 1);
    const [a] = fromGemini([{ type: "click", x: 999, y: 0 }]);
    expect(a).toMatchObject({ type: "click", x: 1279, y: 0 });
    expect(fromGemini([{ type: "navigate", url: "https://example.com" }])).toEqual([]);
  });
});
