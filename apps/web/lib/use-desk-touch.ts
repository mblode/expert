import { useCallback, useEffect, useRef } from "react";

import { distance, midpoint } from "./desk-view";
import type { Point } from "./desk-view";
import type { DeskViewController } from "./use-desk-view";

/**
 * Fingers, turned into the four things a desk understands.
 *
 * A phone has no hover, no wheel, no right button and no keyboard, so every
 * one of them is a gesture here, and the set is the one the iOS client
 * teaches: tap to click where you tapped, one finger drags, two fingers
 * scroll, two fingers tap or one finger holds for the right button, pinch to
 * magnify, and two fingers pan once magnified. Nothing about it is discovered
 * by trying, which is why `ComputerHelp` states it in the same words.
 *
 * Trackpad mode swaps the first two: the finger carries the pointer instead of
 * pointing at a place, which is the only way to hit a 12-pixel checkbox on a
 * desk squeezed to a fifth of its size without magnifying first.
 */

/** Held this long without moving, a finger is asking for the right button. */
const LONG_PRESS_MS = 500;
/** Longer than this and two fingers were a gesture, not a tap. */
const TAP_MS = 300;
/** A second tap this soon after the first, in trackpad mode, starts a drag. */
const DOUBLE_TAP_MS = 300;
/** CSS pixels a finger may wander and still count as a tap. */
const TAP_SLOP = 8;
/** How far two fingers must separate before the gesture is a pinch, not a drag. */
const PINCH_SLOP = 16;
/** A finger crosses more ground than the pointer it carries, or a desk needs two swipes. */
const TRACKPAD_GAIN = 1.4;

/** What the touch layer is allowed to do to the box. Implemented by `useSeatInput`. @public */
export interface DeskPointer {
  /** Point the box at a client coordinate. */
  aimAt: (client: Point) => void;
  /** Queue a click at wherever the box is aimed, once it has arrived there. */
  click: (button: "left" | "right") => void;
  /** Move the aim by a delta in surface pixels, trackpad style. */
  nudge: (dx: number, dy: number) => void;
  /** Hold or release the left button across moves. */
  setDragging: (down: boolean) => void;
  /** Scroll by a delta in surface pixels, sign as the content should move. */
  scrollBy: (dx: number, dy: number) => void;
  /** The element the gestures happen on, for measuring against. */
  surfaceRef: React.RefObject<HTMLDivElement | null>;
}

export type DeskMode = "direct" | "trackpad";

interface TouchHandlers {
  cancel: (event: React.PointerEvent) => void;
  down: (event: React.PointerEvent) => void;
  move: (event: React.PointerEvent) => void;
  up: (event: React.PointerEvent) => void;
}

/**
 * `dead` is a gesture that has already had its effect: the long press that
 * fired, the third finger, the pinch that has ended. Its remaining events are
 * dropped rather than classified, so lifting off after a right click does not
 * also click.
 */
type Phase = "idle" | "single" | "multi" | "dead";

const clientPoint = (event: React.PointerEvent): Point => ({ x: event.clientX, y: event.clientY });

export function useDeskTouch(
  pointer: DeskPointer,
  view: DeskViewController,
  opts: { active: boolean; mode: DeskMode },
): TouchHandlers {
  const touches = useRef(new Map<number, Point>());
  const phase = useRef<Phase>("idle");

  const startedAt = useRef<{ at: Point; time: number }>({ at: { x: 0, y: 0 }, time: 0 });
  const moved = useRef(false);
  const dragging = useRef(false);
  const longPress = useRef<number | undefined>(undefined);
  const lastTap = useRef<{ at: Point; time: number } | null>(null);

  const pinchStart = useRef({ distance: 0, scale: 1 });
  const pinching = useRef(false);
  const lastMid = useRef<Point>({ x: 0, y: 0 });
  const multiMoved = useRef(false);

  // The latest props, read inside handlers that are created once.
  const state = useRef({ ...opts, pointer, view });
  useEffect(() => {
    state.current = { ...opts, pointer, view };
  });

  useEffect(() => () => window.clearTimeout(longPress.current), []);

  const endDrag = useCallback(() => {
    if (dragging.current) {
      dragging.current = false;
      state.current.pointer.setDragging(false);
    }
  }, []);

  const cancelLongPress = useCallback(() => {
    window.clearTimeout(longPress.current);
    longPress.current = undefined;
  }, []);

  /** Container coordinates for the pinch focal point, which is what the view clamps against. */
  const inContainer = useCallback((client: Point): Point => {
    const rect = state.current.view.containerRef.current?.getBoundingClientRect();
    return rect ? { x: client.x - rect.left, y: client.y - rect.top } : client;
  }, []);

  const down = useCallback(
    (event: React.PointerEvent) => {
      const { active, mode, pointer: api } = state.current;
      if (!active) {
        return;
      }
      // Captured per finger so a gesture that wanders off a letterboxed desk
      // still reports its moves and its release. Without it a two-finger drag
      // that leaves the stage leaves the box holding a button.
      event.currentTarget.setPointerCapture(event.pointerId);
      touches.current.set(event.pointerId, clientPoint(event));

      if (touches.current.size === 1) {
        cancelLongPress();
        phase.current = "single";
        moved.current = false;
        startedAt.current = { at: clientPoint(event), time: event.timeStamp };

        if (mode === "direct") {
          // Touch has no hover, so the press is the first this pane hears of
          // where the finger is pointing.
          api.aimAt(clientPoint(event));
        } else {
          const previous = lastTap.current;
          const quick = previous && event.timeStamp - previous.time < DOUBLE_TAP_MS;
          const near = previous && distance(previous.at, clientPoint(event)) <= TAP_SLOP * 3;
          if (quick && near) {
            // Double-tap and hold: the second press is the button going down,
            // and the finger carries the pointer while it stays down.
            dragging.current = true;
            api.setDragging(true);
            lastTap.current = null;
            return;
          }
        }

        longPress.current = window.setTimeout(() => {
          if (phase.current !== "single" || moved.current) {
            return;
          }
          phase.current = "dead";
          endDrag();
          api.click("right");
        }, LONG_PRESS_MS);
        return;
      }

      if (touches.current.size === 2) {
        cancelLongPress();
        endDrag();
        phase.current = "multi";
        const [a, b] = [...touches.current.values()];
        if (!(a && b)) {
          return;
        }
        pinchStart.current = {
          distance: distance(a, b),
          scale: state.current.view.scaleRef.current,
        };
        lastMid.current = midpoint(a, b);
        pinching.current = false;
        multiMoved.current = false;
        startedAt.current = { at: lastMid.current, time: event.timeStamp };
        return;
      }

      // Three fingers is not a gesture here, and guessing at one would fire
      // whichever two-finger reading the extra touch happened to leave behind.
      cancelLongPress();
      endDrag();
      phase.current = "dead";
    },
    [cancelLongPress, endDrag],
  );

  const move = useCallback(
    (event: React.PointerEvent) => {
      const { active, mode, pointer: api, view: desk } = state.current;
      if (!active || !touches.current.has(event.pointerId)) {
        return;
      }
      const previous = touches.current.get(event.pointerId) as Point;
      const at = clientPoint(event);
      touches.current.set(event.pointerId, at);

      if (phase.current === "single") {
        if (distance(startedAt.current.at, at) > TAP_SLOP) {
          moved.current = true;
          cancelLongPress();
        }
        if (mode === "direct") {
          api.aimAt(at);
          // A finger that has travelled is dragging: press, and keep pressing
          // while it moves. A tap never gets here.
          if (moved.current && !dragging.current) {
            dragging.current = true;
            api.setDragging(true);
          }
          return;
        }
        api.nudge((at.x - previous.x) * TRACKPAD_GAIN, (at.y - previous.y) * TRACKPAD_GAIN);
        return;
      }

      if (phase.current !== "multi" || touches.current.size < 2) {
        return;
      }
      const [a, b] = [...touches.current.values()];
      if (!(a && b)) {
        return;
      }
      const spread = distance(a, b);
      const mid = midpoint(a, b);
      const step = { x: mid.x - lastMid.current.x, y: mid.y - lastMid.current.y };
      lastMid.current = mid;
      if (Math.abs(spread - pinchStart.current.distance) > PINCH_SLOP) {
        pinching.current = true;
      }
      // Measured from where the fingers landed, not per frame: two fingers
      // resting on glass jitter by a pixel, and a tap that counted that as
      // travel would never be a tap.
      if (distance(startedAt.current.at, mid) > TAP_SLOP) {
        multiMoved.current = true;
      }

      if (pinching.current && pinchStart.current.distance > 0) {
        desk.pinch(
          inContainer(mid),
          (pinchStart.current.scale * spread) / pinchStart.current.distance,
        );
        desk.pan(step.x, step.y);
        return;
      }
      if (desk.zoomed) {
        desk.pan(step.x, step.y);
        return;
      }
      // Two fingers on a desk at rest are the wheel. The sign is the trackpad's:
      // fingers going up send the page down.
      api.scrollBy(-step.x, -step.y);
    },
    [cancelLongPress, inContainer],
  );

  const finish = useCallback(
    (event: React.PointerEvent, cancelled: boolean) => {
      const { active, pointer: api } = state.current;
      touches.current.delete(event.pointerId);
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      cancelLongPress();

      if (!active || cancelled) {
        endDrag();
        phase.current = touches.current.size === 0 ? "idle" : "dead";
        return;
      }

      if (phase.current === "single") {
        const tap = !moved.current && event.timeStamp - startedAt.current.time < LONG_PRESS_MS;
        if (dragging.current) {
          endDrag();
        } else if (tap) {
          // Direct mode aimed at the press; trackpad mode clicks wherever the
          // pointer was left. Either way the queue waits for the box to arrive.
          api.click("left");
          lastTap.current = { at: startedAt.current.at, time: event.timeStamp };
        }
      } else if (phase.current === "multi" && touches.current.size <= 1) {
        const quick = event.timeStamp - startedAt.current.time < TAP_MS;
        if (quick && !multiMoved.current && !pinching.current) {
          api.aimAt(startedAt.current.at);
          api.click("right");
        }
        endDrag();
      }

      // A gesture ends when the last finger leaves. Until then whatever is
      // still down belongs to the gesture that just finished.
      phase.current = touches.current.size === 0 ? "idle" : "dead";
    },
    [cancelLongPress, endDrag],
  );

  return {
    cancel: (event) => finish(event, true),
    down,
    move,
    up: (event) => finish(event, false),
  };
}
