import { describe, expect, it } from "vitest";

import {
  clampScale,
  clampView,
  isZoomed,
  MAX_DESK_SCALE,
  panView,
  RESTING_VIEW,
  viewTransform,
  zoomAbout,
} from "./desk-view";
import type { DeskBox } from "./desk-view";

/** A 1280x800 desk letterboxed onto a portrait phone: 390 wide, 244 tall, in 700 of height. */
const PHONE: DeskBox = {
  container: { height: 700, width: 390 },
  stage: { height: 244, width: 390 },
};

describe("clampScale", () => {
  it("keeps the desk between life size and the readable ceiling", () => {
    expect(clampScale(0.2)).toBe(1);
    expect(clampScale(2.5)).toBe(2.5);
    expect(clampScale(50)).toBe(MAX_DESK_SCALE);
    expect(clampScale(Number.NaN)).toBe(1);
  });
});

describe("clampView", () => {
  it("re-centres a desk that fits, whatever pan it was left with", () => {
    expect(clampView({ scale: 1, x: 120, y: -80 }, PHONE)).toEqual(RESTING_VIEW);
  });

  it("stops a magnified desk being dragged off its own edge", () => {
    // At 2x the stage is 780x488 inside a 390x700 box: 390 pixels of it are
    // off screen horizontally and it may travel exactly that far, while
    // vertically it still fits, so that axis is re-centred rather than pinned.
    const dragged = clampView({ scale: 2, x: -10_000, y: 0 }, PHONE);
    expect(dragged.x).toBe(-390);
    expect(dragged.y).toBe(-122);
    expect(dragged.scale).toBe(2);

    expect(clampView({ scale: 2, x: 10_000, y: 0 }, PHONE).x).toBe(0);
  });

  it("leaves the view alone when the stage has not been laid out yet", () => {
    const unmeasured: DeskBox = {
      container: { height: 0, width: 0 },
      stage: { height: 0, width: 0 },
    };
    expect(clampView({ scale: 3, x: 5, y: 5 }, unmeasured)).toEqual({ scale: 3, x: 5, y: 5 });
  });
});

describe("zoomAbout", () => {
  it("keeps the pixel under the fingers under the fingers", () => {
    const focal = { x: 100, y: 400 };
    const zoomed = zoomAbout(RESTING_VIEW, PHONE, focal, 2);
    // The stage's left edge in container coordinates, before and after. The
    // distance from the finger to that edge should have doubled with the
    // magnification, which is what "the same pixel" means here.
    const restingLeft = (390 - 390) / 2;
    expect((focal.x - (restingLeft + zoomed.x)) / 2).toBeCloseTo(focal.x - restingLeft, 5);
    // Vertically the desk still fits, so the clamp re-centres it and the
    // focal point does not survive: that is the clamp winning, on purpose.
    expect(zoomed.y).toBe(-122);
  });

  it("never magnifies past the ceiling, or below life size", () => {
    expect(zoomAbout(RESTING_VIEW, PHONE, { x: 0, y: 0 }, 99).scale).toBe(MAX_DESK_SCALE);
    expect(zoomAbout({ scale: 2, x: 0, y: 0 }, PHONE, { x: 0, y: 0 }, 0.1)).toEqual(RESTING_VIEW);
  });
});

describe("panView", () => {
  it("does nothing at rest, because there is nothing off screen to reach", () => {
    expect(panView(RESTING_VIEW, PHONE, 60, 60)).toEqual(RESTING_VIEW);
  });

  it("moves a magnified desk by the finger's delta, up to its edge", () => {
    const zoomed = zoomAbout(RESTING_VIEW, PHONE, { x: 195, y: 350 }, 2);
    const panned = panView(zoomed, PHONE, -40, 0);
    expect(panned.x).toBe(zoomed.x - 40);
    expect(panView(zoomed, PHONE, -10_000, 0).x).toBe(-390);
  });
});

describe("isZoomed and viewTransform", () => {
  it("reports rest as not zoomed and renders the transform the stage wears", () => {
    expect(isZoomed(RESTING_VIEW)).toBe(false);
    expect(isZoomed({ scale: 1.4, x: 0, y: 0 })).toBe(true);
    expect(viewTransform({ scale: 2, x: -12, y: 3 })).toBe("translate(-12px, 3px) scale(2)");
  });
});
