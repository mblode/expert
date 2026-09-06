---
description: "Review a design or an existing system for the smallest shape that is correct. Use when asked whether an approach is right, or before a change large enough to be worth arguing about."
---

# Architecture review

The question is never "is this good code". It is "what is the smallest
system that is correct here, and how far is this from it".

## What to look for, in order

1. **A boundary in the wrong place.** Which module knows something it
   should not? Where does the same rule live twice? Layering that is
   documented but not enforced is not layering.
2. **State that has two owners.** Two places writing one file, one fact
   stored in two shapes, a cache nobody invalidates.
3. **Machinery with one caller.** An interface, a factory, a queue or a
   config knob that exists for a case that has never happened. Name it
   and propose deleting it.
4. **A failure mode nobody chose.** What happens when this is down, slow,
   half written, or called twice? Fail closed or fail open is a decision;
   the absence of one is a bug waiting.
5. **The security seam.** What can the least trusted party in this
   picture reach? Say it plainly, no matter what the change was about.

## What to write

A short verdict, then at most five findings, each: what is wrong, the
failure it produces, and the smallest change that removes it. Rank by
consequence, not by how easy they are to fix.

Say "this is right, leave it" when it is. A review that always finds five
things is a review nobody believes.

## What not to do

Do not open a PR from a review. A review that rewrites the system in the
same run is not a review; hand the human the verdict and let them pick
what gets built. If they say build it, that is `skills/ship-a-change`,
one change at a time.
