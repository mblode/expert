---
description: "Write a multi-step outbound or lifecycle sequence. Use when one message is not the ask, for onboarding, trials, and follow-ups."
---

# Sequences

A sequence is one argument split across time, not the same email sent
four times.

## Rules

- **Every step carries something new.** A new piece of proof, a new
  angle, a new question. A step that only says "following up" is deleted
  from the sequence, not rewritten.
- **Each step stands alone.** People read the third one first.
- **The exit is in every step.** One line, plain, no dark pattern.
- **Trigger, not timer, wherever the tool allows it.** "Three days after
  they created a project and did not invite anyone" beats "day 3".
- **Stop on reply.** Always. A sequence that keeps sending after a human
  answered is the fastest way to lose them.
- **Four steps at most** for cold outbound. Lifecycle can be longer when
  every step is triggered by something the person did.

## The file

`/workspace/gtm/campaigns/<slug>/sequence.md`, one block per step: the
trigger or delay, the subject, the body, the exit condition, and what it
is trying to learn.

## Reading it

Per step: sent, replied, and the action you actually wanted. Opens are
not a result and clicks are barely one; say so when the human asks how it
went. Numbers come from the sending tool with the window, never from
memory and never rounded up.
