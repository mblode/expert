---
description: "How to drive this hub's screen with the computer tool: coordinates, batching, zoom, takeover, and error semantics. Load before any screen work."
---

# Using my computer's screen

This Bot owns **one** 1280×800 display on this Linux computer (Xvfb +
Chromium). Origin is top-left, scale 1. The hub already mapped this
process's bot token to that screen: you never name a display, a VNC
port, or a seat token.

Every `x`,`y` you send is a pixel of the **last full-display
screenshot**. `zoom` returns a magnified crop for reading small text,
but the coordinate space never changes: your next click is still in
the full 1280×800 frame.

The human watches this same screen at hello.expert (noVNC, view-only).
They take the seat with Seat RPCs, not RFB input. You do not hold their
seat token.

## The computer tool

One call takes a `request_id` (any unique string; retrying with the same
id returns the first result instead of double-clicking) and an ordered
list of 1–20 `actions`:

| action                   | fields               | notes                                             |
| ------------------------ | -------------------- | ------------------------------------------------- |
| `screenshot`             |                      | look before you touch                             |
| `click` / `double_click` | `x`, `y`, `button?`  | `left` default; `right`, `middle`                 |
| `move`                   | `x`, `y`             | pointer only                                      |
| `drag`                   | `path: [{x,y}, …]`   | down at first point, up at last                   |
| `scroll`                 | `x`, `y`, `dx`, `dy` | wheel ticks at a point                            |
| `keypress`               | `keys: ["ctrl","c"]` | one chord                                         |
| `type`                   | `text`               | unicode into the focused field                    |
| `wait`                   | `ms`                 | ≤ 8000                                            |
| `zoom`                   | `x`, `y`, `w`, `h`   | read small text; coords stay full-frame           |
| `request_takeover`       |                      | hand the seat to the human; terminal in the batch |

Actions run in order. On the first failure the rest are skipped, read
the per-action results, fix, retry with a **new** `request_id`. After
each batch you get a fresh screenshot; look at it before the next batch.

## Rules that save you

- **Screenshot first.** Never click from memory; the screen may have changed.
- **The browser is an app.** There is no navigate action: focus the URL bar
  (click it or `ctrl+l`), `type` the address, `keypress` Enter.
- **Batch small.** 2–5 actions, then look. Long blind batches drift.
- **`OUT_OF_BOUNDS`** means your coordinate left 1280×800: re-screenshot.
- **`pending_checks`** in a response (credential / destructive / exfil) means
  stop and hand over: `request_takeover`, tell the human why.
- **`SEAT_HELD`** means the human has the seat right now. Wait for them.

## Files and terminal

`shell` runs argv (no login shell, 120 s cap) in `/workspace`; `read_file` /
`write_file` are UTF-8 under `/workspace` only. Editing a file beats opening
an editor on screen.

Roster and bot tokens live under `/workspace/.computer`. Do not print them.
Do not invent a setup code. Do not book Cal.com.
