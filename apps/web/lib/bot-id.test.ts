import { describe, expect, it } from "vitest";
import { botIdFrom } from "./bot-id";

describe("the id a Bot keeps", () => {
  it("is the name, lower case and hyphenated", () => {
    expect(botIdFrom("Night Shift")).toBe("night-shift");
    expect(botIdFrom("  Chief of Staff  ")).toBe("chief-of-staff");
    expect(botIdFrom("QA")).toBe("qa");
  });

  it("keeps punctuation and accents out of a path segment", () => {
    expect(botIdFrom("Ops & Admin")).toBe("ops-admin");
    expect(botIdFrom("Café")).toBe("cafe");
    expect(botIdFrom("../etc/passwd")).toBe("etc-passwd");
  });

  it("is empty when the name leaves nothing, rather than inventing one", () => {
    expect(botIdFrom("🙂")).toBe("");
    expect(botIdFrom("   ")).toBe("");
  });

  it("is capped, because it is a directory name", () => {
    expect(botIdFrom("a".repeat(80))).toHaveLength(32);
  });
});
