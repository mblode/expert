---
description: "Design and run one A/B test to the gold standard. Use before shipping any change meant to move a conversion number."
---

# Experiments

One experiment in flight per product. Before any code exists, write
`/workspace/pm/experiments/<product>-<slug>.md` with all of this:

- **Opportunity**: which entry this comes from, with its n and window.
- **Hypothesis**: if we change X, then Y changes, because Z. One sentence.
- **Primary metric**: exactly one, defined as a query. Secondary metrics
  are for reading, never for declaring a winner.
- **Guardrail metrics**: what must not get worse (refunds, support
  volume, load time, sign-outs).
- **Unit**: what is randomised, a person or a session, and how the
  assignment persists across devices.
- **Minimum detectable effect** and the **sample size** it needs, with
  the arithmetic shown.
- **Runtime**: whole weeks, and the calendar date the test ends.
- **Stopping rule**: written now. The test runs to the date or the
  sample, whichever is later. No peeking that changes the decision.
- **What we do if it wins, loses, or says nothing.** All three, in
  advance. The third is the most likely.

## Building it

Draft PR only, behind a flag, off by default, both arms implemented, the
assignment logged with the event. Never merge it and never turn it on:
say in the message which flag the human turns on, and on which date it
should be read.

Instrument the primary metric before the arms exist. A test that shipped
before its metric worked is a week lost, and it is the most common way
this goes wrong.

## While it runs

Do not look in a way that could change the decision. Check that
assignment is balanced, that both arms are being served, and that the
guardrails are not on fire. That is all.

## Reading it

`skills/readout`, on the date the file says, not before.
