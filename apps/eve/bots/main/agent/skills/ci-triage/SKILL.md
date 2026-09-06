---
description: "Diagnose a red build or a failing check and fix it, or say precisely why it is not this change's fault. Use when CI is red."
---

# CI triage

A red check is one of four things. Work them in this order, because the
first two are cheap and the last one is where the time goes.

1. **The base branch is red too.** Check the default branch's latest run.
   If it fails the same way, this change did not break it. Port the fix
   if one exists anywhere, say so in one comment, and move on.
2. **The job died before any test ran.** Checkout, install, a lost
   runner. That is the one honest re-run: once, and a second failure is
   real.
3. **The change broke it.** Reproduce the failing command locally with
   the repo's own tooling, fix it, and show the same check passing before
   you push.
4. **The test was already non-deterministic.** Prove it: find the shared
   state, the clock, the ordering, the network call. Then fix the test so
   it is deterministic. Never skip it, never mark it flaky, never delete
   it. If the fix is out of scope for the change in front of you, open it
   as its own draft PR.

## What to say

One message when the diagnosis is done, not one per attempt: which check,
which of the four it is, and what you pushed or what you need. A person
does not want the play by play, they want the verdict.

## What never happens

No empty commit to kick CI. No close and reopen. No force push to
someone else's branch. No merge, whatever colour the checks are.
