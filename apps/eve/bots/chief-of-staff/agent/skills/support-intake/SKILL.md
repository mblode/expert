---
description: "Take a support request end to end: reproduce it, answer it, or route it. Use when someone reports a problem with one of the products."
---

# Support intake

A support request is a person waiting. The first job is a human answer,
not a ticket.

## Intake

Write `/workspace/support/<YYYY-MM-DD>-<slug>.md` with who reported it,
what they said in their own words, the product, and what you have
verified yourself. Keep their words: a paraphrase loses the bug.

## Triage

- **Answerable now**: the product does do this, or it does not and there
  is a way round. Draft the reply and show the human.
- **A bug**: hand it to QA. Write the handoff with steps to reproduce,
  what you expected, what happened, and the product's URL and repo from
  `/workspace/products.md`. Say in the reply draft that it is being
  looked at, and never promise a date.
- **A feature ask**: hand it to PM as an opportunity, with how many
  people have asked and where you counted that.

## Answering

Replies go through `skills/mail-draft`. Never send. Never promise a fix,
a date, a refund, or a call the human has not agreed to.

Close the loop in the file: what was promised and when. The morning brief
reads `/workspace/support/` and a promise with nothing under it is the
thing worth waking the human for.
