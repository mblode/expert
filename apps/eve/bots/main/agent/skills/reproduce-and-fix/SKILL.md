---
description: "Turn a bug report into a reproduction, a failing test, and a draft fix PR. Use for any report that something is broken."
---

# Reproduce and fix

## 1. Reproduce

Nothing else starts until you have seen it. Write down, in the incident
or bug file: the exact steps, the environment (which URL, which build,
signed in as whom), what you expected, and what happened.

If you cannot reproduce it, say so with what you tried. Ask for the one
missing thing (a screenshot, the account, the time it happened). Do not
"fix" a bug you have never seen.

## 2. Narrow it

Halve the problem until the failing surface is one function, one query,
one request. `git log` and `git bisect` are faster than reading when the
thing used to work. Name the commit or the change that introduced it when
you can.

## 3. A failing test

Write the smallest test that fails for this reason and passes when it is
fixed, in the repo's own test style. This is the deliverable even when
the fix turns out to be someone else's: a failing test is a bug that
cannot come back quietly.

## 4. Fix

The smallest change that makes the test pass without breaking the rest.
If the fix needs a decision (an API change, a schema change, a behaviour
someone chose on purpose), stop: write what you found and hand it to
the person through `send_message`, with the file at `/workspace/handoffs/`.

## 5. Draft PR

Run the repo's own checks, read your diff adversarially, then push a
branch and open a **draft** PR. Never merge. The body: what was broken,
how to reproduce it, the root cause in one sentence, the fix, and the
test that now covers it.

Then append a line to `/workspace/qa/regression.md`: what broke, how it
was found, and what now catches it.
