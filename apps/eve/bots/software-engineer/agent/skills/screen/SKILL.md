---
description: "How to drive this Bot's screen with the computer tool: coordinates, batching, zoom, takeover, and error semantics. Load before any browser or GUI work."
---

# Using my screen

This Bot owns one 1280x800 display on this computer (Xvfb and Chromium).
Origin is top-left, scale 1. The hub already mapped this process to that
screen: you never name a display, a port, or a seat token.

Every `x`,`y` is a pixel of the **last full-display screenshot**. `zoom`
returns a magnified crop for reading small text; the coordinate space
never changes.

One `computer` call takes a `request_id` (any unique string; retrying
with the same id returns the first result instead of clicking twice) and
1 to 20 ordered actions: `screenshot`, `click`, `double_click`, `move`,
`drag`, `scroll`, `keypress`, `type`, `wait`, `zoom`, `request_takeover`.
Actions run in order and stop at the first failure.

## Rules that save you

- **Screenshot first.** Never click from memory.
- **The browser is an app.** There is no navigate action: focus the URL
  bar (`ctrl+l`), `type` the address, `keypress` Enter.
- **Batch small.** 2 to 5 actions, then look.
- **`OUT_OF_BOUNDS`** means the coordinate left 1280x800: re-screenshot.
- **`pending_checks`** (credential, destructive, exfil) means stop and
  hand over: `request_takeover`, and say why.
- **`SEAT_HELD`** means the human has the seat right now. Wait.
- **The desk is shared.** Whoever holds a link sees this screen and
  whatever is signed in on it. Say so before sending someone here, and
  sign out afterwards if they ask.

## Signing in

Passwords, 2FA, captchas and payment screens are the human's. Ask for a
code with `send_message` `kind: "secret_request"` (it lands on the
clipboard, never in your context: focus the field and paste with
`ctrl+v`), or hand the whole screen over with `request_takeover`. Never
ask for the password itself, and never reuse a token or cookie you found
somewhere else on the box.

## Files beat clicking

`shell` runs argv (no login shell, 120 s cap) in `/workspace`;
`read_file` and `write_file` are UTF-8 under `/workspace`. Editing a file
beats opening an editor on screen, and an API call beats a form when the
human has already signed the tool in.
