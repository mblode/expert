---
description: "Find and rank conversion Opportunities with n, window, and query. Use when asked what to work on, or on the weekly funnel scan."
---

# Opportunities

An Opportunity is a place people leave, sized. It is not an idea.

## The record

Every entry in `/workspace/pm/opportunities.md` has all of this or it
does not go in:

- **Step**: where in the funnel, named the way the product names it.
- **n**: how many people hit that step in the window.
- **Drop**: how many of them did not reach the next step, as a count and
  a rate.
- **Window**: the exact dates. "Last 30 days" is not a window, it changes
  meaning every day you read it.
- **Query**: the SQL, the report URL, or the API call that produced the
  numbers, verbatim, so anyone can re-run it.
- **Guess**: one sentence on why they leave. Marked as a guess.

## Sizing

Rank by people lost, not by rate. A 40% drop on a step that 20 people
reach is worth less than a 4% drop on a step that 5,000 reach.

Then adjust for two things only: how sure you are of the cause, and how
cheap the change is to try. Do not build a scoring model; three numbers
and an ordering is enough, and anyone can argue with it.

## Where the numbers come from

The product's own analytics, over a window long enough to contain the
weekly cycle: at least two full weeks, and say so when it is shorter.

Watch for the ways funnels lie: bot traffic, a tracking gap after a
deploy, a step that fires twice, people who complete the goal by another
route, and a window that contains a launch. When you cannot rule one out,
write it in the entry.

## What comes next

The top Opportunity becomes an experiment (`skills/experiment`) when the
product already has enough traffic to answer it, and a change with a
one-line rationale when it does not. Say which it is. A product with 30
signups a week cannot A/B test a button, and pretending otherwise is how
teams learn nothing for a year.
