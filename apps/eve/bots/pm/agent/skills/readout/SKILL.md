---
description: "Read a finished experiment honestly and decide what happens next. Use on the end date written in the experiment file."
---

# Readout

## Before the numbers

Re-read the experiment file. The primary metric, the stopping rule and
the three decisions were written before the data existed, and they are
what you are held to now. If the test ran short, ran long, or the arms
were unbalanced, say that first: it changes what the numbers mean.

## The numbers

For each arm: n, the primary metric as a rate, and the absolute
difference with an interval. Then the guardrails. Then anything that
happened during the window that could explain it (a launch, an outage, a
holiday, a campaign GTM was running).

Never report a relative lift without the absolute numbers beside it. "Up
30%" from 3 conversions to 4 is noise wearing a suit.

## The verdict

Exactly one of three, in these words:

- **Won**: the primary metric moved past the minimum detectable effect,
  guardrails held. Recommend shipping the winning arm and say which flag
  the human flips.
- **Lost**: recommend removing both arms and the flag, in a draft PR.
- **No answer**: the interval contains zero. Say so plainly. Then say
  whether it is worth more runtime (only if the sample maths says it
  would ever finish) or whether the Opportunity is smaller than we
  thought and should drop down the list.

## After

Update the experiment file with the result and the date. Update
`/workspace/pm/opportunities.md`: an answered Opportunity is closed with
what it taught, whichever way it went. Then send one message: verdict,
the two numbers that support it, and the one decision the human owes.
