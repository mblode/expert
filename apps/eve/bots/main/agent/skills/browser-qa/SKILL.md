---
description: "Test a product the way a person uses it, in the browser on my screen. Use before a release, after a UI change, or when a bug only happens in a real browser."
---

# Browser QA

Read `skills/computer-use` first if you have not this session. This is the test
that catches what unit tests cannot: the thing that is broken only when a
human does it.

## The pass

Take the product's main path end to end, as a person who has never seen
it. For each step: screenshot, act, screenshot. Record what you did and
what you saw, not what you assume happened.

Always check, whatever the change was:

- **The empty state.** A new account, no data. This is the most common
  broken screen in any product.
- **The slow path.** A form submitted twice, a click while it is already
  loading, a refresh mid-flow.
- **The narrow window.** Resize to a phone width and look again.
- **Signed out.** Every page a signed-out person can reach.
- **The error you can cause.** A wrong password, a bad file, a rejected
  card in test mode.

## What counts as a finding

A screenshot, the steps, the URL, and the build. A finding without a
reproduction is an opinion. Rank findings by whether a person loses work,
loses money, or is merely annoyed, in that order.

## After

Write the pass into `/workspace/qa/<product>-<YYYY-MM-DD>.md`. Fix what
is clearly a bug through `skills/reproduce-and-fix`. Anything that is a
design or product judgement goes to the person or PM as a handoff, with the
screenshot, not to a PR of yours.
