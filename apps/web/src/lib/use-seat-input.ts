import { useCallback, useEffect, useRef, useState } from "react";

import type { Seat } from "./seat";

/** Pointer deltas are batched into one RPC per tick rather than per mousemove. */
const POINTER_TICK_MS = 40;
/** One wheel notch in `deltaMode: pixel`. The hub scrolls in notches. */
const WHEEL_NOTCH = 100;
const MAX_NOTCHES = 8;
/**
 * `Seat.Type` pastes (clipboard + ctrl-v on the box), so a keystroke per RPC
 * would be one paste per character. Keys are buffered and sent as a run.
 */
const TYPE_IDLE_MS = 300;

export type SeatInput = {
  error: string | null;
  /** Attach to the drawn cursor; it is moved directly, not through React. */
  cursorRef: React.RefObject<HTMLDivElement | null>;
  handlers: {
    onPointerMove: (event: React.PointerEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerLeave: () => void;
    onClick: () => void;
    onAuxClick: (event: React.MouseEvent) => void;
    onContextMenu: (event: React.MouseEvent) => void;
    onWheel: (event: React.WheelEvent) => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onPaste: (event: React.ClipboardEvent) => void;
    onBlur: () => void;
  };
};

/**
 * Turns browser input over the (view-only) desktop stream into Seat RPCs.
 *
 * The cursor you see is drawn here, not streamed. The real one is a round trip
 * away — RPC, docker exec, X, then a VNC frame — so a cursor made of pixels
 * always trails the mouse by a visible lag and the pane feels broken. This
 * paints a local cursor the instant the mouse moves and lets the box catch up.
 *
 * Because the drawn cursor is the one being aimed, the box is steered to an
 * absolute position rather than by accumulated deltas: each tick asks for the
 * difference between where you are pointing and where the box last said it
 * was. A dropped or clamped move then corrects itself on the next tick, where
 * summed deltas would have drifted apart for good.
 */
export function useSeatInput(
  seat: Seat,
  display: number,
  active: boolean,
  desk: { width: number; height: number },
): SeatInput {
  const [error, setError] = useState<string | null>(null);

  /** Where the human is pointing, in the box's pixels. The drawn cursor. */
  const aim = useRef<{ x: number; y: number } | null>(null);
  /** Where the box last told us its cursor is. */
  const boxCursor = useRef<{ x: number; y: number } | null>(null);
  /** The drawn cursor element, moved directly so a mousemove costs no render. */
  const cursorRef = useRef<HTMLDivElement | null>(null);
  const inFlight = useRef(false);
  const dragging = useRef(false);
  const dragged = useRef(false);
  /** What the box last heard about the left button, so `grab` is edge-driven. */
  const held = useRef(false);
  const wheel = useRef({ dx: 0, dy: 0 });
  const typed = useRef("");
  const typeTimer = useRef<number | undefined>(undefined);

  const activeRef = useRef(active);
  activeRef.current = active;
  const targetRef = useRef({ seat, display, desk });
  targetRef.current = { seat, display, desk };

  const run = useCallback(async (call: (seat: Seat, display: number) => Promise<unknown>) => {
    const { seat: current, display: screen } = targetRef.current;
    try {
      await call(current, screen);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "input rejected");
    }
  }, []);

  const flushTyped = useCallback(() => {
    window.clearTimeout(typeTimer.current);
    const text = typed.current;
    typed.current = "";
    if (text) void run((current, screen) => current.type(text, screen));
  }, [run]);

  // One pointer RPC in flight at a time; whatever accumulated meanwhile rides
  // on the next tick. Without this a single flick queues dozens of requests.
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => {
      if (inFlight.current) return;
      const target = aim.current;
      const grab = dragging.current;
      // Nothing to say when the box is already under the drawn cursor and the
      // button has not changed.
      const at = boxCursor.current;
      const dx = target && at ? Math.round(target.x - at.x) : 0;
      const dy = target && at ? Math.round(target.y - at.y) : 0;
      if (dx === 0 && dy === 0 && grab === held.current) return;
      held.current = grab;
      inFlight.current = true;
      void run(async (current, screen) => {
        const result = await current.move(dx, dy, grab, screen);
        // The box is the authority on where its cursor ended up; believing it
        // is what keeps the aim from drifting away over a long drag.
        if (result?.cursor) boxCursor.current = result.cursor;
        return result;
      }).finally(() => {
        inFlight.current = false;
      });
    }, POINTER_TICK_MS);
    return () => window.clearInterval(id);
  }, [active, run]);

  useEffect(() => () => window.clearTimeout(typeTimer.current), []);

  const scale = (event: { currentTarget: Element }): { x: number; y: number } => {
    const rect = event.currentTarget.getBoundingClientRect();
    const { desk: size } = targetRef.current;
    return {
      x: rect.width > 0 ? size.width / rect.width : 1,
      y: rect.height > 0 ? size.height / rect.height : 1,
    };
  };

  return {
    error,
    cursorRef,
    handlers: {
      onPointerMove: (event) => {
        if (!activeRef.current) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const { desk: size } = targetRef.current;
        const x = clamp(((event.clientX - rect.left) / rect.width) * size.width, size.width);
        const y = clamp(((event.clientY - rect.top) / rect.height) * size.height, size.height);
        aim.current = { x, y };
        // Paint immediately, outside React: a mousemove must not cost a render.
        const el = cursorRef.current;
        if (el) {
          el.style.left = `${(x / size.width) * 100}%`;
          el.style.top = `${(y / size.height) * 100}%`;
          el.style.opacity = "1";
        }
        // The box has not reported a position yet, so assume it is where we
        // are pointing; the first move's response replaces this.
        boxCursor.current ??= { x, y };
        if (dragging.current && (event.movementX !== 0 || event.movementY !== 0)) {
          dragged.current = true;
        }
      },
      onPointerDown: (event) => {
        if (!activeRef.current || event.button !== 0) return;
        dragging.current = true;
        dragged.current = false;
      },
      // Letting go is an edge the flush loop notices: it sends the next move
      // with `grab` off, which is what releases the button on the box.
      onPointerUp: () => {
        dragging.current = false;
      },
      onPointerLeave: () => {
        dragging.current = false;
      },
      onClick: () => {
        if (!activeRef.current) return;
        // A drag already pressed and released; the browser's click is a duplicate.
        if (dragged.current) {
          dragged.current = false;
          return;
        }
        void run((current, screen) => current.click("left", screen));
      },
      onAuxClick: (event) => {
        if (!activeRef.current || event.button !== 1) return;
        event.preventDefault();
        void run((current, screen) => current.click("middle", screen));
      },
      onContextMenu: (event) => {
        event.preventDefault();
        if (!activeRef.current) return;
        void run((current, screen) => current.click("right", screen));
      },
      onWheel: (event) => {
        if (!activeRef.current) return;
        wheel.current.dx += event.deltaX;
        wheel.current.dy += event.deltaY;
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
  };
}

function clamp(value: number, size: number): number {
  return Math.max(0, Math.min(size - 1, value));
}

function clampNotches(pixels: number): number {
  const notches = Math.trunc(pixels / WHEEL_NOTCH);
  return Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, notches));
}
