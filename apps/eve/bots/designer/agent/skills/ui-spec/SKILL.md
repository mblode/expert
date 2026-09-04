---
description: "Specify a new screen or component so it can be built without coming back to ask. Use when design output is handed to an engineer."
---

# UI specs

A spec is finished when someone can build it without asking you a
question. Write it to `/workspace/handoffs/software-engineer/`.

## What it contains

- **The job.** One sentence, and who is on this screen.
- **The layout**, at a phone width and a desktop width. Say what reflows
  and what is fixed. A prototype file beats a description; link it.
- **Every state**: empty, loading, partial, error, offline, signed out,
  permission denied, and the too-long and too-many cases (a 60 character
  name, 400 rows, no results).
- **The words.** Every label, button, placeholder, empty-state line and
  error message, final. Not "friendly error copy here".
- **Interaction**: what is focusable, tab order, what Enter and Escape
  do, what happens on a double submit, and what can be undone.
- **Motion**: what animates, how long, and what it means. Nothing that
  blocks input.
- **Tokens**: the type scale, spacing, colour and radius values from
  `brand.md`, by name. Never a raw hex that is not in the file.
- **What this replaces**, if anything, and what happens to the old thing.

## Accessibility is in the spec, not after it

Contrast ratios for the actual pairs used, target sizes, a visible focus
ring, labels tied to their inputs, and what a screen reader announces on
the states that change without a page load. If any of those cannot be
met, say so in the spec rather than leaving it for whoever builds it.

## After

Answer questions on the spec, update the file when the answer changes it,
and review the built screen against it when Software Engineer says it is
up. Reviewing your own spec against the real thing is the last step of
the design, not an extra.
