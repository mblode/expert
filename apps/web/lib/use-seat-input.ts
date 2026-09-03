import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Point } from "./desk-view";
import { useDeskTouch } from "./use-desk-touch";
import type { DeskMode, DeskPointer } from "./use-desk-touch";
import type { DeskViewController } from "./use-desk-view";
import type { Button, Seat } from "./seat";

/** Pointer deltas are batched into one RPC per tick rather than per mousemove. */
const POINTER_TICK_MS = 40;
/** One wheel notch in `deltaMode: pixel`. The hub scrolls in notches. */
const WHEEL_NOTCH = 100;
/** Pixels per line and per page for the other two `deltaMode`s (Firefox reports lines). */
const LINE_PX = 16;
const PAGE_PX = 800;
const MAX_NOTCHES = 8;
/**
 * Ceiling on how long a keystroke waits for company, not the normal wait.
 *
 * Typing used to be buffered for a flat 300ms because `Seat.Type` pasted
 * through the clipboard and took two seconds a call, so batching hard was the
 * only way to keep up. It is one `xdotool type` now (~65ms), so the buffer
 * flushes as soon as the previous run lands and this only catches the case
 * where nothing is in flight and the person is still typing: fast enough to
 * feel direct, slow enough that a burst still travels as one run.
 */
const TYPE_IDLE_MS = 30;
/**
 * CSS pixels a pointer may wander before the gesture counts as a drag. A mouse
 * does not move at all between press and release; a finger always does.
 */
const TAP_SLOP = 8;

/** What `useSeatInput` returns, so a component can name the shape it spreads. @public */
export interface SeatInput {
  error: string | null;
  /** Attach to the drawn cursor; it is moved directly, not through React. */
  cursorRef: React.RefObject<HTMLDivElement | null>;
  /** Put the pointer back in the middle of the desk, when trackpad mode has lost it. */
  recenter: () => void;
  /**
   * Type a run of text at the box. The touch keyboard composes a line and
   * sends it whole rather than forwarding keystrokes, because `Seat.Type` is a
   * paste: nothing already sent can be taken back, and Backspace has nowhere
   * to land.
   */
  send: (text: string) => void;
  /** Attach to the input surface: the gestures measure and capture against it. */
  surfaceRef: React.RefObject<HTMLDivElement | null>;
  handlers: {
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerUp: (event: React.PointerEvent) => void;
    onPointerCancel: (event: React.PointerEvent) => void;
    onPointerLeave: (event: React.PointerEvent) => void;
    onClick: (event: React.MouseEvent) => void;
    onAuxClick: (event: React.MouseEvent) => void;
    onContextMenu: (event: React.MouseEvent) => void;
    onWheel: (event: React.WheelEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onPaste: (event: React.ClipboardEvent) => void;
    onBlur: () => void;
  };
}

/**
 * Turns browser input over the (view-only) desktop stream into Seat RPCs.
 *
 * The cursor you see is drawn here, not streamed. The real one is a round trip
 * away, RPC, docker exec, X, then a VNC frame, so a cursor made of pixels
 * always trails the mouse by a visible lag and the pane feels broken. This
 * paints a local cursor the instant the mouse moves and lets the box catch up.
 *
 * Because the drawn cursor is the one being aimed, the box is steered to an
 * absolute position rather than by accumulated deltas: each tick asks for the
 * difference between where you are pointing and where the box last said it
 * was. A dropped or clamped move then corrects itself on the next tick, where
 * summed deltas would have drifted apart for good.
 *
 * A touch screen has no hover, so the aim arrives with the press and the box
 * is still somewhere else when the tap ends. Pressing and clicking therefore
 * wait for the box to arrive; only steering happens on every tick. Fingers are
 * classified in `useDeskTouch` and reach the box through the same queue.
 */
export function useSeatInput(
  seat: Seat,
  display: number,
  active: boolean,
  desk: { width: number; height: number },
  opts: { mode?: DeskMode; view?: DeskViewController } = {},
): SeatInput {
  const [rejection, setRejection] = useState<string | null>(null);

  /** Where the human is pointing, in the box's pixels. The drawn cursor. */
  const aim = useRef<{ x: number; y: number } | null>(null);
  /** Where the box last told us its cursor is. */
  const boxCursor = useRef<{ x: number; y: number } | null>(null);
  /** The drawn cursor element, moved directly so a mousemove costs no render. */
  const cursorRef = useRef<HTMLDivElement | null>(null);
  /** The surface the pointer is aimed over: gestures measure against its rect. */
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const dragging = useRef(false);
  const dragged = useRef(false);
  /** Where the press landed, in CSS pixels, to measure the slop against. */
  const downAt = useRef<{ x: number; y: number } | null>(null);
  /** A click the box owes, once it has been steered to where you tapped. */
  const pendingClick = useRef<Button | null>(null);
  /** What the box last confirmed about the left button, so `grab` is edge-driven. */
  const held = useRef(false);
  const wheel = useRef({ dx: 0, dy: 0 });
  const typed = useRef("");
  const typeTimer = useRef<number | undefined>(undefined);
  /** A touch tap synthesizes a mouse click and a long press a context menu; both are already handled. */
  const lastPointerType = useRef<string>("mouse");

  // Latest props for the timer and handlers, updated after commit rather than
  // during render so the React Compiler can memoise the caller.
  const activeRef = useRef(active);
  const targetRef = useRef({ desk, display, seat });
  useEffect(() => {
    activeRef.current = active;
    targetRef.current = { desk, display, seat };
  }, [active, seat, display, desk]);

  const run = useCallback(async (call: (seat: Seat, display: number) => Promise<unknown>) => {
    const { seat: current, display: screen } = targetRef.current;
    try {
      await call(current, screen);
      setRejection(null);
    } catch (error) {
      setRejection(error instanceof Error ? error.message : "input rejected");
    }
  }, []);

  // One `Seat.Type` in flight at a time, and whatever was typed meanwhile
  // rides on the next one. This is the pointer path's rule applied to keys,
  // and it is what makes the buffer self-tuning: with the box answering in
  // ~65ms the first keystroke leaves immediately and only a genuinely faster
  // typist ever batches, while a slow box coalesces more without a fixed
  // delay guessed in advance.
  const typing = useRef(false);
  // The drain step calls the flush again, and a `useCallback` cannot name
  // itself while it is still initializing. The ref is written in an effect,
  // which is also what keeps this component compilable by the React Compiler.
  const flushRef = useRef<() => void>(() => undefined);

  const flushTyped = useCallback(() => {
    window.clearTimeout(typeTimer.current);
    if (typing.current) {
      return;
    }
    const text = typed.current;
    typed.current = "";
    if (!text) {
      return;
    }
    typing.current = true;
    void run((current, screen) => current.type(text, screen)).finally(() => {
      typing.current = false;
      // Whatever was typed while that was in flight goes now, as one run.
      if (typed.current) {
        flushRef.current();
      }
    });
  }, [run]);

  useEffect(() => {
    flushRef.current = flushTyped;
  }, [flushTyped]);

  const send = useCallback(
    (text: string) => {
      if (!activeRef.current || !text) {
        return;
      }
      typed.current += text;
      flushTyped();
    },
    [flushTyped],
  );

  // One pointer RPC in flight at a time; whatever accumulated meanwhile rides
  // on the next tick. Without this a single flick queues dozens of requests.
  useEffect(() => {
    if (!active) {
      return;
    }
    const id = window.setInterval(() => {
      if (inFlight.current) {
        return;
      }
      const target = aim.current;
      const at = boxCursor.current;
      const dx = target && at ? Math.round(target.x - at.x) : 0;
      const dy = target && at ? Math.round(target.y - at.y) : 0;
      // Not settled until the box has said where it is: a zero move is the
      // cheapest way to ask, and pressing before the answer would press blind.
      const settled = at !== null && dx === 0 && dy === 0;
      // The box presses before it moves, so grabbing with ground still to
      // cover would drag from wherever it was standing rather than from where
      // you touched. Letting go never waits, a release that needed the box to
      // settle first could leave the button down for good.
      const grab = dragging.current && (settled || held.current);
      // Same reason the click waits: sent before the box arrives it lands
      // wherever the pointer was last left, which on a touch screen is the
      // previous tap.
      const click = settled ? pendingClick.current : null;
      // Nothing to say when the box is already under the drawn cursor and the
      // button has not changed.
      if (settled && grab === held.current && !click) {
        return;
      }
      inFlight.current = true;
      void run(async (current, screen) => {
        if (!settled || grab !== held.current) {
          const result = await current.move(dx, dy, grab, screen);
          // Only once the box has acknowledged the button state. Recording it
          // before the call meant a failed release left the box holding the
          // button with nothing left to send.
          held.current = grab;
          // The box is the authority on where its cursor ended up; believing
          // it is what keeps the aim from drifting away over a long drag. The
          // fallback only stops a desk that answers without a cursor from
          // being asked again every tick.
          boxCursor.current = result?.cursor ?? boxCursor.current ?? { x: 0, y: 0 };
        }
        if (click) {
          pendingClick.current = null;
          await current.click(click, screen);
        }
      })
        .catch(() => {})
        .finally(() => {
          inFlight.current = false;
        });
    }, POINTER_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, run]);

  useEffect(() => () => window.clearTimeout(typeTimer.current), []);

  /** Paint the drawn cursor wherever the aim now is. Outside React: a move must not cost a render. */
  const paint = useCallback(() => {
    const spot = aim.current;
    const element = cursorRef.current;
    if (!(spot && element)) {
      return;
    }
    const { desk: size } = targetRef.current;
    element.style.left = `${(spot.x / size.width) * 100}%`;
    element.style.top = `${(spot.y / size.height) * 100}%`;
    element.style.opacity = "1";
  }, []);

  /** Aim at a client point over the surface, and paint the drawn cursor there. */
  const aimAt = useCallback(
    (client: Point) => {
      const rect = surfaceRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        return;
      }
      const { desk: size } = targetRef.current;
      aim.current = {
        x: clamp(((client.x - rect.left) / rect.width) * size.width, size.width),
        y: clamp(((client.y - rect.top) / rect.height) * size.height, size.height),
      };
      paint();
    },
    [paint],
  );

  /**
   * Surface pixels to desk pixels. The surface is the stage's own rect, so it
   * already carries whatever the pinch zoom did to it: a drag across a
   * magnified desk covers less of it, which is the point of magnifying.
   */
  const toDesk = useCallback((dx: number, dy: number): Point | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return null;
    }
    const { desk: size } = targetRef.current;
    return { x: (dx / rect.width) * size.width, y: (dy / rect.height) * size.height };
  }, []);

  const recenter = useCallback(() => {
    const { desk: size } = targetRef.current;
    aim.current = { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
    paint();
  }, [paint]);

  const scrollBy = useCallback(
    (dx: number, dy: number) => {
      const delta = toDesk(dx, dy);
      if (!delta) {
        return;
      }
      wheel.current.dx += delta.x;
      wheel.current.dy += delta.y;
      const notchX = clampNotches(wheel.current.dx);
      const notchY = clampNotches(wheel.current.dy);
      if (notchX === 0 && notchY === 0) {
        return;
      }
      wheel.current.dx -= notchX * WHEEL_NOTCH;
      wheel.current.dy -= notchY * WHEEL_NOTCH;
      void run((current, screen) => current.scroll(notchX, notchY, screen));
    },
    [run, toDesk],
  );

  const pointer: DeskPointer = useMemo(
    () => ({
      aimAt,
      click: (button) => {
        pendingClick.current = button;
      },
      nudge: (dx, dy) => {
        const delta = toDesk(dx, dy);
        if (!delta) {
          return;
        }
        const { desk: size } = targetRef.current;
        const from = aim.current ?? boxCursor.current ?? { x: size.width / 2, y: size.height / 2 };
        aim.current = {
          x: clamp(from.x + delta.x, size.width),
          y: clamp(from.y + delta.y, size.height),
        };
        paint();
      },
      scrollBy,
      setDragging: (down) => {
        dragging.current = down;
      },
      surfaceRef,
    }),
    [aimAt, paint, scrollBy, toDesk],
  );

  const { mode = "direct", view } = opts;
  const touch = useDeskTouch(pointer, view ?? NO_VIEW, { active, mode });

  // Trackpad mode has no place to point at, so the pointer has to already be
  // somewhere when it is switched on, or the first flick moves a cursor nobody
  // can see from a position nobody chose.
  useEffect(() => {
    if (mode === "trackpad" && !aim.current) {
      recenter();
    }
  }, [mode, recenter]);

  const isTouch = (event: { pointerType?: string }): boolean => event.pointerType === "touch";

  return {
    cursorRef,
    error: rejection,
    handlers: {
      // A second finger belongs to a pinch, not to the aim.
      onPointerMove: (event) => {
        if (!activeRef.current) return;
        if (isTouch(event)) {
          touch.move(event);
          return;
        }
        if (!event.isPrimary) return;
        aimAt({ x: event.clientX, y: event.clientY });
        // `movementX` is the obvious test and the wrong one: it is absent on
        // touch, and finger jitter would call every tap a drag anyway.
        const from = downAt.current;
        if (
          dragging.current &&
          from &&
          Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP
        ) {
          dragged.current = true;
        }
      },
      onPointerDown: (event) => {
        lastPointerType.current = event.pointerType;
        if (!activeRef.current) return;
        if (isTouch(event)) {
          touch.down(event);
          return;
        }
        if (!event.isPrimary || event.button !== 0) return;
        aimAt({ x: event.clientX, y: event.clientY });
        downAt.current = { x: event.clientX, y: event.clientY };
        dragging.current = true;
        dragged.current = false;
      },
      // Letting go is an edge the flush loop notices: it sends the next move
      // with `grab` off, which is what releases the button on the box. Only
      // the left button's release ends a left drag.
      onPointerUp: (event) => {
        if (isTouch(event)) {
          touch.up(event);
          return;
        }
        if (!event.isPrimary || event.button !== 0) return;
        dragging.current = false;
      },
      // A pinch steals the gesture mid-press. Without this the box is left
      // holding a mouse button nothing will ever release.
      onPointerCancel: (event) => {
        if (isTouch(event)) {
          touch.cancel(event);
          return;
        }
        dragging.current = false;
      },
      onPointerLeave: (event) => {
        // A captured finger does not leave; a mouse that does has let go.
        if (!isTouch(event)) {
          dragging.current = false;
        }
      },
      onClick: () => {
        if (!activeRef.current) return;
        // The browser synthesizes a click after a touch tap, which the touch
        // layer has already answered with a click of its own.
        if (lastPointerType.current === "touch") return;
        // A drag already pressed and released; the browser's click is a
        // duplicate. So is a click after any press the box saw at all: the
        // release the loop is about to send is itself that click.
        if (dragged.current || held.current) {
          dragged.current = false;
          return;
        }
        pendingClick.current = "left";
      },
      onAuxClick: (event) => {
        if (!activeRef.current || event.button !== 1) return;
        event.preventDefault();
        void run((current, screen) => current.click("middle", screen));
      },
      onContextMenu: (event) => {
        event.preventDefault();
        if (!activeRef.current) return;
        // A long press raises this too, and the touch layer has already sent
        // the right click it stands for.
        if (lastPointerType.current === "touch") return;
        void run((current, screen) => current.click("right", screen));
      },
      onWheel: (event) => {
        if (!activeRef.current) return;
        const scale = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? PAGE_PX : 1;
        wheel.current.dx += event.deltaX * scale;
        wheel.current.dy += event.deltaY * scale;
        const dx = clampNotches(wheel.current.dx);
        const dy = clampNotches(wheel.current.dy);
        if (dx === 0 && dy === 0) return;
        wheel.current.dx -= dx * WHEEL_NOTCH;
        wheel.current.dy -= dy * WHEEL_NOTCH;
        void run((current, screen) => current.scroll(dx, dy, screen));
      },
      onKeyDown: (event) => {
        if (!activeRef.current) return;
        // The Seat API carries text, not keysyms: ctrl-c, Backspace and the
        // arrow keys cannot be expressed, so they stay with the browser.
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key === "Enter") {
          event.preventDefault();
          typed.current += "\n";
          flushTyped();
          return;
        }
        if (event.key.length !== 1) return;
        event.preventDefault();
        typed.current += event.key;
        // Send now when the box is idle; the timer is only the backstop for
        // the keystroke that arrives while a run is still in flight.
        flushTyped();
        window.clearTimeout(typeTimer.current);
        typeTimer.current = window.setTimeout(flushTyped, TYPE_IDLE_MS);
      },
      onPaste: (event) => {
        if (!activeRef.current) return;
        const text = event.clipboardData.getData("text/plain");
        if (!text) return;
        event.preventDefault();
        typed.current += text;
        flushTyped();
      },
      onBlur: flushTyped,
    },
    recenter,
    send,
    surfaceRef,
  };
}

/**
 * A pane with no magnification (the desktop one) still has fingers on a
 * touchscreen laptop; they aim and click, they just have nothing to pinch.
 */
const NO_VIEW: DeskViewController = {
  containerRef: { current: null },
  pan: () => undefined,
  pinch: () => undefined,
  reset: () => undefined,
  scaleRef: { current: 1 },
  stageRef: { current: null },
  zoomed: false,
};

function clamp(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, value));
}

function clampNotches(pixels: number): number {
  const notches = Math.trunc(pixels / WHEEL_NOTCH);
  return Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, notches));
}
