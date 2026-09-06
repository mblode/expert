# Brief: an AI team with a computer of its own

Date: 2026-09-06 · Status: Request

Produced by the seo-program pipeline for the hello.expert front door, the
same day optimise-seo shipped its metadata, schema and robots policy. The
numbers table is the honest state of the research: no volume tool is bound
in this environment and Search Console has no hello.expert property, so
every figure below is "No data" with the reason named, not an estimate.

## Why this page exists

Audience: a solo founder, indie developer or small team lead who already
uses ChatGPT or Claude daily and keeps hitting the wall where the assistant
cannot actually open the browser, sign into the tool and do the task.
Gap: "AI agent" pages either describe a chat window with integrations or a
developer SDK for computer use. Nothing explains, plainly, what it is like
to give an assistant a real computer you can watch and take over.
Job of the page: understand, then decide to ask for access.

## SEO decisions

| Field               | Value                                                                                                                                                           |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Primary keyword     | ai agent with its own computer                                                                                                                                  |
| Search volume       | No data (no keyword tool bound; see the evidence table)                                                                                                         |
| Exact prompt volume | No data (no AI-visibility tool bound)                                                                                                                           |
| Secondary keywords  | always-on ai assistant (No data), computer use agent (No data), whatsapp ai assistant that uses a computer (No data), take over the ai agent's screen (No data) |
| Title               | An AI team with a computer of their own, always on                                                                                                              |
| H1                  | A team of Bots with a computer of their own.                                                                                                                    |
| Meta description    | Give an AI assistant a real Linux computer with a browser, files and a terminal. Watch it work, take the mouse when you want, and hand it back.                 |
| Canonical           | https://hello.expert                                                                                                                                            |

The live title is brand-led ("Expert | A team of Bots with a computer of
their own"). The checklist wants the non-brand keyword to lead; the title
above is the proposed change, held back from this pass because the home
title is the product name on a one-page site and the switch is a copy
decision for the owner.

## North star

Tone: plain, first-hand, a little wry. The reader is technical enough to
know what a VNC session is and tired enough of "agents" to want proof.
The reader should leave knowing: this is a real computer the Bots drive and
you can take, not a chat window with connectors.

## Ideas to land

- The seat is the product: one click makes the screen yours, then you hand
  it back. That is the whole trust model, and it is what "take the mouse"
  means on the page.
- Passwords, 2FA codes and payments stay with the human by construction:
  the Bot asks, the person answers into a masked field, the value goes to
  the computer's clipboard and never through the model.
- It keeps going while nobody is watching: routines wake the computer, the
  Bot reports by WhatsApp, and the record of every exchange is kept.
- Real apps, not integrations: if it runs in a browser or a terminal, the
  Bot can use it today, with no API and nothing to connect.
- One computer, one Bot, made yours by what is on its disk. The page still
  advertises eight Bots; the build ships one since 2026-09-06 and that copy
  needs correcting before the page is promoted.

## Shape

Problem → evidence → questions → how to do it → short close.

## Questions worth answering

Evaluator questions first, then product-specific. Marked where the FAQ
already answers it in the served DOM.

1. What is an AI agent with its own computer, and how is it different from a chatbot with integrations?
2. When would I want an agent to use a real browser instead of an API?
3. How do I watch what the agent is doing, and can I stop it? (covered: "Can I drive it myself?")
4. Who types the passwords and two-factor codes? (covered)
5. What happens to my files and logins between sessions? (covered: "Does it keep my files?")
6. Does it keep working when I close my laptop? (covered: "It keeps going", partly)
7. Can I run it from my phone? (covered: "Can I use it on my iPhone?", but that answer names the removed iOS app and needs rewording to WhatsApp and the web)
8. What can go wrong when an agent has a computer, and what stops it?
9. How is this different from OpenAI Operator, Anthropic computer use, or a browser agent extension?
10. How do I get one, and what does it cost?

Google fans a query out into related ones and retrieves the cluster, so the
page should answer 1, 2, 8 and 9 in prose above the FAQ rather than leaving
them to the accordion.

## Sources the writer can cite

- https://github.com/mblode/expert (the code, MIT)
- https://developers.google.com/search/docs/appearance/ai-features (what AI surfaces need from a page)
- https://developers.openai.com/api/docs/bots (which crawlers put a page in ChatGPT search)
- https://docs.anthropic.com/en/docs/agents-and-tools/computer-use (the category the page competes in)

## Evidence table

| Keyword                                                                                                   | Search volume                                                                  | Exact prompt volume | Source, scope, window                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ai agent with its own computer                                                                            | No data                                                                        | No data             | No keyword or prompt tool is bound in this environment (no Ahrefs, Semrush or Profound connector); pulled 2026-09-06                                                                                 |
| always-on ai assistant                                                                                    | No data                                                                        | No data             | same                                                                                                                                                                                                 |
| computer use agent                                                                                        | No data                                                                        | No data             | same                                                                                                                                                                                                 |
| whatsapp ai assistant that uses a computer                                                                | No data                                                                        | No data             | same                                                                                                                                                                                                 |
| brand: "hello expert"                                                                                     | 12 impressions, 0 clicks, position 55.9                                        | No data             | Google Search Console, hello.expert property, top queries as pasted by Matt on 2026-09-06 (default window, not stated); brand search volume is the one number content will not move                  |
| brand variants: "hello experts", "helloexperts", "hello experts login", "helloexpert", "hello expert.com" | 6, 5, 4, 3, 1 impressions; 0 clicks; positions 53 to 85 (the .com form at 8.0) | No data             | same pull                                                                                                                                                                                            |
| "ondemand ai expert"                                                                                      | 10 impressions, 0 clicks, position 93.3                                        | No data             | same pull; the one non-brand query, and it is a different product category                                                                                                                           |
| Search performance, hello.expert                                                                          | see the rows above                                                             | n/a                 | The property exists in Search Console. The PostHog warehouse (project Blode.co) does not carry it, so monitoring cannot read it yet: add hello.expert to the Google Search Console source in PostHog |

What the pull says. Every query with impressions is the brand or a
misspelling of it, plus one navigational form ("hello experts login") and
one unrelated category ("ondemand ai expert"). Zero clicks across all of
them, and the exact brand phrase at position 55.9, means Google has not yet
tied the domain to its own name: the site had no canonical, no structured
data and no robots policy until 2026-09-06, and the property is new. The
first thing to watch is that one row moving toward the top after the
metadata and schema land; content cannot move it, indexing can. "Hello
Expert" is now an `alternateName` on the WebSite and Organization for the
same reason.

What to do about the gaps, in order: connect the hello.expert property to
the PostHog Search Console source so monitoring can read it; bind a keyword
tool; rerun this table and write the next brief as a new file rather than
editing this one.
