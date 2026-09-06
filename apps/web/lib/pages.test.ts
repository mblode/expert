import { describe, expect, it } from "vitest";

import { GUIDES, MARKDOWN_PATHS, pageMarkdown } from "./pages";

describe("the public pages as data", () => {
  it("has unique guide slugs and five standalone takeaways each", () => {
    expect(new Set(GUIDES.map((g) => g.slug)).size).toBe(GUIDES.length);
    for (const guide of GUIDES) {
      expect(guide.takeaways).toHaveLength(5);
      expect(guide.steps.length).toBeGreaterThanOrEqual(4);
      expect(guide.faqs.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("renders a Markdown twin for every negotiable path and nothing else", () => {
    for (const path of MARKDOWN_PATHS) {
      const md = pageMarkdown(path);
      expect(md, path).not.toBeNull();
      expect(md?.startsWith("# ")).toBe(true);
      expect(md).not.toContain("undefined");
    }
    expect(pageMarkdown("/guides/not-a-guide")).toBeNull();
    expect(pageMarkdown("/work")).toBeNull();
  });
});
