#!/usr/bin/env python3
"""Absolute pointer + keys via /dev/uinput. Not XSendEvent."""
from __future__ import annotations

import sys
import time

from evdev import AbsInfo, UInput, ecodes as e

WIDTH = 1280
HEIGHT = 800

ABS = {
    e.ABS_X: AbsInfo(0, 0, WIDTH - 1, 0, 0, 0),
    e.ABS_Y: AbsInfo(0, 0, HEIGHT - 1, 0, 0, 0),
}

KEYS = {
    "ctrl": e.KEY_LEFTCTRL,
    "control": e.KEY_LEFTCTRL,
    "alt": e.KEY_LEFTALT,
    "shift": e.KEY_LEFTSHIFT,
    "meta": e.KEY_LEFTMETA,
    "win": e.KEY_LEFTMETA,
    "enter": e.KEY_ENTER,
    "return": e.KEY_ENTER,
    "tab": e.KEY_TAB,
    "esc": e.KEY_ESC,
    "escape": e.KEY_ESC,
    "backspace": e.KEY_BACKSPACE,
    "space": e.KEY_SPACE,
    "up": e.KEY_UP,
    "down": e.KEY_DOWN,
    "left": e.KEY_LEFT,
    "right": e.KEY_RIGHT,
    "delete": e.KEY_DELETE,
    "home": e.KEY_HOME,
    "end": e.KEY_END,
    "pageup": e.KEY_PAGEUP,
    "pagedown": e.KEY_PAGEDOWN,
}

BUTTONS = {
    "left": e.BTN_LEFT,
    "right": e.BTN_RIGHT,
    "middle": e.BTN_MIDDLE,
    "back": e.BTN_SIDE,
    "forward": e.BTN_EXTRA,
}

CAP = {
    e.EV_KEY: [
        e.BTN_LEFT,
        e.BTN_RIGHT,
        e.BTN_MIDDLE,
        e.BTN_SIDE,
        e.BTN_EXTRA,
        *range(e.KEY_ESC, e.KEY_MICMUTE + 1),
    ],
    e.EV_ABS: ABS,
    e.EV_REL: [e.REL_WHEEL, e.REL_HWHEEL],
}


def keycode(name: str) -> int:
    n = name.lower()
    if n in KEYS:
        return KEYS[n]
    if len(n) == 1:
        attr = f"KEY_{n.upper()}"
        if hasattr(e, attr):
            return int(getattr(e, attr))
    attr = f"KEY_{n.upper()}"
    if hasattr(e, attr):
        return int(getattr(e, attr))
    raise SystemExit(f"unknown key {name}")


def main(argv: list[str]) -> int:
    if not argv or argv[0] in {"-h", "--help"}:
        print("uinputd ping|move x y|click btn [--double]|down btn|up btn|scroll dx dy|key k+", file=sys.stderr)
        return 2
    cmd = argv[0]
    if cmd == "ping":
        print("ok")
        return 0

    ui = UInput(CAP, name="computer-uinput", version=0x1)
    try:
        if cmd == "move":
            x, y = int(argv[1]), int(argv[2])
            ui.write(e.EV_ABS, e.ABS_X, max(0, min(WIDTH - 1, x)))
            ui.write(e.EV_ABS, e.ABS_Y, max(0, min(HEIGHT - 1, y)))
            ui.syn()
        elif cmd == "click":
            btn = BUTTONS[argv[1]]
            times = 2 if "--double" in argv else 1
            for _ in range(times):
                ui.write(e.EV_KEY, btn, 1)
                ui.syn()
                time.sleep(0.03)
                ui.write(e.EV_KEY, btn, 0)
                ui.syn()
                time.sleep(0.05)
        elif cmd == "down":
            ui.write(e.EV_KEY, BUTTONS[argv[1]], 1)
            ui.syn()
        elif cmd == "up":
            ui.write(e.EV_KEY, BUTTONS[argv[1]], 0)
            ui.syn()
        elif cmd == "scroll":
            dx, dy = int(argv[1]), int(argv[2])
            if dy:
                ui.write(e.EV_REL, e.REL_WHEEL, dy)
            if dx:
                ui.write(e.EV_REL, e.REL_HWHEEL, dx)
            ui.syn()
        elif cmd == "key":
            codes = [keycode(k) for k in argv[1:]]
            for c in codes:
                ui.write(e.EV_KEY, c, 1)
            ui.syn()
            time.sleep(0.03)
            for c in reversed(codes):
                ui.write(e.EV_KEY, c, 0)
            ui.syn()
        else:
            print(f"unknown {cmd}", file=sys.stderr)
            return 2
    finally:
        ui.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
