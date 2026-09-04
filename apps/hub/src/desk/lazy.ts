import type { Desk } from "./types.ts";

/**
 * A Desk whose screen is brought up by using it.
 *
 * `ScreenKeeper` decides when a window is claimed and released; this is where
 * "used" is defined, and it is deliberately the X methods only. A Bot that
 * reads a file, writes one, or runs a command in `/workspace` needs no
 * desktop, and claiming one for it would spend 430 MB on a window nobody
 * looks at. `screenshot` through `focusHint` are the calls that need an X
 * server, from the model's `computer` tool and from every human seat RPC
 * alike, so both paths come through here and neither can forget.
 *
 * The list is written out rather than proxied on purpose: a method added to
 * `Desk` shows up here as a type error, which is the review this file exists
 * to force.
 */
export function screenOnDemand(desk: Desk, use: () => Promise<void>): Desk {
  const onScreen =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      await use();
      return await fn(...args);
    };
  return {
    click: onScreen((x, y, button) => desk.click(x, y, button)),
    clipboardGet: onScreen(() => desk.clipboardGet()),
    clipboardSet: onScreen((text) => desk.clipboardSet(text)),
    doubleClick: onScreen((x, y, button) => desk.doubleClick(x, y, button)),
    drag: onScreen((path) => desk.drag(path)),
    focusHint: onScreen(() => desk.focusHint()),
    // The cursor the box last reported. Synchronous, and reading it must not
    // wake a screen: `Seat.Status` asks every display for one.
    getCursor: () => desk.getCursor(),
    keypress: onScreen((keys) => desk.keypress(keys)),
    move: onScreen((x, y) => desk.move(x, y)),
    // Liveness, not use. A probe that claimed a window would make every
    // health read cost a Chromium.
    ping: () => desk.ping(),
    pointerClick: onScreen((button) => desk.pointerClick(button)),
    pointerDelta: onScreen((dx, dy, grab) => desk.pointerDelta(dx, dy, grab)),
    readFile: (path) => desk.readFile(path),
    screenshot: onScreen(() => desk.screenshot()),
    scroll: onScreen((x, y, dx, dy) => desk.scroll(x, y, dx, dy)),
    shell: (argv, cwd, timeoutSec) => desk.shell(argv, cwd, timeoutSec),
    type: onScreen((text) => desk.type(text)),
    writeFile: (path, content) => desk.writeFile(path, content),
    zoom: onScreen((x, y, w, h) => desk.zoom(x, y, w, h)),
  };
}
