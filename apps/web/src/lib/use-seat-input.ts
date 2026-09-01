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
 * The pointer is relative, not absolute: the API moves the box's cursor by a
 * delta, so this reads like a trackpad rather than a remote desktop. Deltas are
 * CSS pixels scaled to the box's own resolution.
 */
export function useSeatInput(
  seat: Seat,
  display: number,
  active: boolean,
  desk: { width: number; height: number },
): SeatInput {
  const [error, setError] = useState<string | null>(null);

  const pending = useRef({ dx: 0, dy: 0 });
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
      const { dx, dy } = pending.current;
      const grab = dragging.current;
      if (dx === 0 && dy === 0 && grab === held.current) return;
      pending.current = { dx: 0, dy: 0 };
      held.current = grab;
      inFlight.current = true;
      void run((current, screen) => current.move(dx, dy, grab, screen)).finally(() => {
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
    handlers: {
      onPointerMove: (event) => {
        if (!activeRef.current) return;
        const factor = scale(event);
        pending.current.dx += event.movementX * factor.x;
        pending.current.dy += event.movementY * factor.y;
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
        pending.current = { dx: 0, dy: 0 };
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

function clampNotches(pixels: number): number {
  const notches = Math.trunc(pixels / WHEEL_NOTCH);
  return Math.max(-MAX_NOTCHES, Math.min(MAX_NOTCHES, notches));
}
