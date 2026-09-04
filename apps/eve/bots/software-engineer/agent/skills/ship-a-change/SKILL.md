---
description: "Take a change from ask to draft PR in one run: branch, build, verify, push, open a draft. Use for any code the human wants landed."
---

# Shipping one change

One run, one change, one draft PR. If the ask is three changes, say so,
do the first, and leave the rest in the PR body.

## 1. Understand before typing

Read the repo's `AGENTS.md` or `CONTRIBUTING.md`, then the code around
the change. Find the existing thing that already does most of this: a
new helper beside a helper that does the same job is the most common way
these repos rot.

Say in one message what you are about to change and why, then start.

## 2. Branch

`git -C /workspace/src/<repo> fetch origin <default-branch>` then
`git -C ... checkout -b <slug> origin/<default-branch>`. Never build on
a branch someone else is using.

## 3. Build the smallest correct thing

- The behaviour the human asked for, and nothing adjacent.
- A test that fails without the change, in the repo's own test style.
- No new dependency without saying what it costs.

## 4. Verify before you push

Run what the repo runs: its typecheck, its lint, its tests. Read your own
diff line by line as if you were reviewing someone else. Two questions:
what would make CI reject this, and what did I change that nobody asked
for. Fix both before pushing.

A failing check is a result, not a blocker to hide: if you cannot get it
green, push nothing and say what fails and what you think it needs.

## 5. Draft PR

Push the branch, open the PR as a **draft**, and never merge it. Follow
the repo's PR template when it has one. The body says what changed, why,
what you verified (the actual commands and their outcome), and what you
deliberately left out.

Send the human the link, the one-line summary, and anything that failed.
