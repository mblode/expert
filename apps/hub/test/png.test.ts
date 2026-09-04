import { describe, expect, it } from "vitest";
import { pngSize } from "../src/desk/png.ts";

/** 2×3 PNG, so a transposed read is visible rather than square-shaped luck. */
const PNG_2x3 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAABfmDlPAAAAEklEQVR4nGP8//8/AzJgYkAFAB8FAwGVSAoGAAAAAElFTkSuQmCC",
  "base64",
);

describe("pngSize", () => {
  it("reads the IHDR without decoding pixels", () => {
    expect(pngSize(PNG_2x3)).toEqual({ height: 3, width: 2 });
  });

  it("returns undefined rather than throwing on anything it cannot read", () => {
    expect(pngSize(Buffer.from("not a png at all, but long enough to index"))).toBeUndefined();
    expect(pngSize(Buffer.alloc(0))).toBeUndefined();
    // Right signature, truncated before the IHDR: a partial read must not be
    // reported as a size of zero.
    expect(pngSize(PNG_2x3.subarray(0, 12))).toBeUndefined();
  });
});
