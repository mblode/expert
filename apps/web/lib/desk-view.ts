/**
 * Pinch-zoom and pan over the desk, as arithmetic.
 *
 * A 1280x800 desk on a phone is about 240 CSS pixels tall, which is under a
 * fifth of the size it was drawn for: a menu item is three pixels of text and
 * a checkbox is smaller than the finger aiming at it. The invite page turns
 * the browser's own zoom off (`userScalable: false`), because a page that
 * scrolls and scales underneath the stream makes every tap land somewhere
 * else, so the magnification a phone needs has to be part of the pane.
 *
 * The stage is the letterboxed rectangle holding the stream. It is centred by
 * layout at rest, so the view is stored as an offset from that resting place
 * and `{ scale: 1, x: 0, y: 0 }` needs no measurement to mean "as laid out".
 * Everything here is pure: the hook applies the result to the DOM.
 *
 * It is applied as a transform on the stage rather than by resizing it, and
 * that costs nothing in sharpness: noVNC keeps the canvas backing store at the
 * full 1280x800 and only scales it down in CSS (`scaleViewport`), and a phone
 * at 3x renders a 390-wide frame as ~1170 device pixels, so the raster being
 * magnified already holds nearly every pixel the desk has. Resizing instead
 * would reflow a cross-origin iframe and re-run noVNC's rescale on every frame
 * of the pinch.
 */

/** Far enough in to read a menu item on a phone; further is unusable jitter. */
export const MAX_DESK_SCALE = 5;
const MIN_DESK_SCALE = 1;

export interface DeskView {
  scale: number;
  x: number;
  y: number;
}

export const RESTING_VIEW: DeskView = { scale: 1, x: 0, y: 0 };

export interface Size {
  height: number;
  width: number;
}

/** What the clamp measures against: the black box, and the stage laid out in it. */
export interface DeskBox {
  container: Size;
  stage: Size;
}

export interface Point {
  x: number;
  y: number;
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) {
    return MIN_DESK_SCALE;
  }
  return Math.min(MAX_DESK_SCALE, Math.max(MIN_DESK_SCALE, scale));
}

export const isZoomed = (view: DeskView): boolean => view.scale > MIN_DESK_SCALE + 0.01;

/** Where the stage sits with no transform: centred in the container. */
function restingTopLeft(box: DeskBox): Point {
  return {
    x: (box.container.width - box.stage.width) / 2,
    y: (box.container.height - box.stage.height) / 2,
  };
}

function topLeft(view: DeskView, box: DeskBox): Point {
  const resting = restingTopLeft(box);
  return { x: resting.x + view.x, y: resting.y + view.y };
}

/**
 * One axis of the clamp: a stage smaller than the container is centred, and a
 * stage larger than it may not be dragged past its own edge.
 *
 * Centring the small case rather than clamping it to zero is what stops a
 * pinch out then back in from leaving the desk stuck against one edge with a
 * black margin on the other.
 */
function clampAxis(position: number, scaled: number, container: number): number {
  if (scaled <= container) {
    return (container - scaled) / 2;
  }
  return Math.min(0, Math.max(container - scaled, position));
}

export function clampView(view: DeskView, box: DeskBox): DeskView {
  if (box.stage.width <= 0 || box.stage.height <= 0) {
    return view;
  }
  const scale = clampScale(view.scale);
  const at = topLeft({ ...view, scale }, box);
  const resting = restingTopLeft(box);
  return {
    scale,
    x: clampAxis(at.x, box.stage.width * scale, box.container.width) - resting.x,
    y: clampAxis(at.y, box.stage.height * scale, box.container.height) - resting.y,
  };
}

/**
 * Scale to `nextScale` while the pixel under `focal` stays under `focal`.
 *
 * The focal point is the midpoint between the two fingers, in container
 * coordinates. Without it a pinch magnifies the centre of the stage, so
 * whatever you were pinching at slides out from under the gesture.
 */
export function zoomAbout(view: DeskView, box: DeskBox, focal: Point, nextScale: number): DeskView {
  const scale = clampScale(nextScale);
  const ratio = scale / view.scale;
  const at = topLeft(view, box);
  const resting = restingTopLeft(box);
  return clampView(
    {
      scale,
      x: focal.x - (focal.x - at.x) * ratio - resting.x,
      y: focal.y - (focal.y - at.y) * ratio - resting.y,
    },
    box,
  );
}

export function panView(view: DeskView, box: DeskBox, dx: number, dy: number): DeskView {
  return clampView({ ...view, x: view.x + dx, y: view.y + dy }, box);
}

/** `transform` for the stage. Origin is its own top-left, which is what the math assumes. */
export function viewTransform(view: DeskView): string {
  return `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
