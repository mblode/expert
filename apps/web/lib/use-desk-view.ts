import { useCallback, useEffect, useRef, useState } from "react";

import { clampView, isZoomed, panView, RESTING_VIEW, viewTransform, zoomAbout } from "./desk-view";
import type { DeskBox, DeskView, Point } from "./desk-view";

/** Magnification of the desk on a phone, and where a pinch left it. @public */
export interface DeskViewController {
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Pan by a delta in container pixels. Two fingers, once magnified. */
  pan: (dx: number, dy: number) => void;
  /** Scale about a focal point in container coordinates. */
  pinch: (focal: Point, scale: number) => void;
  reset: () => void;
  /** The live scale, read inside a gesture without waiting for a render. */
  scaleRef: React.RefObject<number>;
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** Magnified right now. State, because the controls and the gesture branch change with it. */
  zoomed: boolean;
}

/**
 * The desk's own zoom, applied to the DOM rather than through React.
 *
 * A pinch fires a move event per frame per finger and every one of them
 * changes the transform, so this follows `useSeatInput`'s rule for the drawn
 * cursor: the value lives in a ref and is written straight onto the element.
 * Only `zoomed` is state, because it is the one thing the rest of the pane
 * behaves differently about (two fingers pan a magnified desk and scroll a
 * resting one) and it flips once per gesture, not once per frame.
 */
export function useDeskView(): DeskViewController {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const view = useRef<DeskView>(RESTING_VIEW);
  const scaleRef = useRef(RESTING_VIEW.scale);
  const [zoomed, setZoomed] = useState(false);

  const apply = useCallback((next: DeskView) => {
    view.current = next;
    scaleRef.current = next.scale;
    const stage = stageRef.current;
    if (stage) {
      stage.style.transform = viewTransform(next);
    }
    setZoomed(isZoomed(next));
  }, []);

  const measure = useCallback((): DeskBox | null => {
    const container = containerRef.current;
    const stage = stageRef.current;
    if (!container || !stage || stage.offsetWidth === 0) {
      return null;
    }
    return {
      container: { height: container.clientHeight, width: container.clientWidth },
      // Layout size, which `offsetWidth` reports without the transform this
      // hook just wrote onto the same element.
      stage: { height: stage.offsetHeight, width: stage.offsetWidth },
    };
  }, []);

  const pinch = useCallback(
    (focal: Point, scale: number) => {
      const box = measure();
      if (box) {
        apply(zoomAbout(view.current, box, focal, scale));
      }
    },
    [apply, measure],
  );

  const pan = useCallback(
    (dx: number, dy: number) => {
      const box = measure();
      if (box) {
        apply(panView(view.current, box, dx, dy));
      }
    },
    [apply, measure],
  );

  const reset = useCallback(() => apply(RESTING_VIEW), [apply]);

  // A rotation changes both boxes at once, and a view clamped to the old one
  // leaves the desk hanging off the edge with black where the screen was.
  useEffect(() => {
    const onResize = () => {
      const box = measure();
      if (box) {
        apply(clampView(view.current, box));
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [apply, measure]);

  return { containerRef, pan, pinch, reset, scaleRef, stageRef, zoomed };
}
