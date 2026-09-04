# The Bots on this computer

One computer, sixteen screens, and eight Bots that arrive with the build. Each of those is a directory under
[`apps/eve/bots`](../apps/eve/bots): its profile, its instructions, its
skills, its schedules, and any door something outside can knock on. The
directory is the agent, so a Bot arrives with a deploy and not with a form.

They are **not** a security boundary. Same box user, same `/workspace`, same
browser profiles when they share a screen. The split is about attention and
scope, not trust: see `api/DESIGN.md`.

## The roster

| Bot                 | Screen | Owns                                                             | Never                                        | Wakes on                                                         |
| ------------------- | ------ | ---------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------- |
| `main`              | 1      | The desk itself: screen, files, terminal, WhatsApp               | Booking, pairing, inventing a setup code     | You, and a daily box health check                                |
| `chief-of-staff`    | 2      | Calendar, mail drafts, morning brief, support intake, your voice | Sending, publishing, merging                 | You, and the weekday morning brief                               |
| `designer`          | 3      | Product, UI and brand design, obsessive reduction                | Merging, standing routines                   | You                                                              |
| `gtm`               | 4      | Campaigns, listings, founder emails, sequence copy               | Sending live, inventing ICP or proof         | You                                                              |
| `pm`                | 5      | Conversion drop-offs, ranked Opportunities, A/B tests            | Merging, deploying, two tests at once        | You, and a weekly funnel scan                                    |
| `qa`                | 6      | Incidents, CI failures, regression, browser QA, fixes            | Merging, deploying, skipping a test          | You, weekday health, twice-daily prod smoke, an incident webhook |
| `seo`               | 7      | Demand research, writer briefs, Search Console, technical fixes  | Writing the article, publishing              | You, and a weekly Search Console read                            |
| `software-engineer` | 8      | Building and landing code, architecture review                   | Merging, deploying, more than one PR per run | You, and Sunday hygiene                                          |

Screens are assigned in the order the roster is seeded (`main` first, then
alphabetically), and a Bot keeps its screen once it has one.

## Making one

The eight above arrive with a deploy, because each is a directory in git.
A ninth is made from hello.expert: **New Bot** in the roster, a name, what it
is for, a mark. It gets the next free screen, its own thread and its own
agent token, exactly like the shipped ones.

What it does not get is a directory, and it cannot: that would be a deploy.
It runs `apps/eve/bots/template` instead, which is the same five tools and
the same box, and what makes it itself is its profile. The hub folds the
name, the label and the description into its system prompt before every
turn, so "what is it for" is the brief rather than a note: write it as an
instruction and rewrite it whenever from the Bot's own sheet.

What it does get, and did not before templates, is the rest of a setup on
the volume: `/workspace/.bots/<id>/instructions.md` is a brief the hub folds
into its prompt, `skills.json` plus `skills/<id>.md` are procedures it opens
when it wants them, and `routines.json` and `plugins.json` record its
schedule and the services it expects. Those are written by installing a
template, or by the Bot itself with `write_file`, and they win over anything
its project ships.

Two trades are still real. A routine on a made Bot is **declared, not
running**: what fires one is that Bot's own croner, compiled from
`agent/schedules/*.ts`, and the template project has none, so an installed
routine is recorded and shown as paused. And a made Bot has no webhook,
because a channel is code. When one earns either, give it a directory and it
becomes a shipped Bot under the same id, keeping its screen, its thread and
its token.

The four that touch code (`software-engineer`, `qa`, `pm`, `seo`) open
**draft** pull requests and merge nothing; `designer` hands its work to them
rather than opening one; `chief-of-staff` and `gtm` draft and never send. Each
of those lines is in that Bot's hard rules, because they are what a human is
trusting when they let eight agents share one signed-in computer. `main` is
the exception: it is the desk agent and predates the rule.

## What they share

`/workspace` is one filesystem, and the Bots use it as the handoff. "Meant
for" is the intent, not an enforced contract: what a Bot actually reads is
what its own instructions tell it to, and `products.md`, `voice.md` and
`handoffs/<bot>/` are the paths every Bot is pointed at today.

| Path                         | Written by            | Meant for                      |
| ---------------------------- | --------------------- | ------------------------------ |
| `products.md`                | you, Chief of Staff   | everyone                       |
| `voice.md`                   | Chief of Staff        | Chief of Staff, GTM            |
| `handoffs/<bot>/`            | any Bot               | the Bot named in the path      |
| `brief/`, `support/`         | Chief of Staff        | you                            |
| `incidents/`, `qa/`          | QA                    | you, Software Engineer         |
| `pm/opportunities.md`        | PM                    | PM, Designer, SEO              |
| `seo/demand/`, `seo/briefs/` | SEO                   | you, GTM                       |
| `gtm/icp.md`, `gtm/proof.md` | you, GTM              | GTM, SEO                       |
| `design/brand.md`            | Designer              | everyone who draws anything    |
| `src/<repo>`                 | Software Engineer, QA | Software Engineer, QA, SEO, PM |

Bots cannot message each other yet (Grok's bot-to-bot DMs are still a gap in
`docs/GROK-BOT.md`), so a handoff is a file plus a sentence to you. Chief of
Staff writes the file even when you are going to ask the specialist
yourself, because the file is the record.

## Routines

Cron is UTC and the human is in Australia/Melbourne, so the schedules read a
day back: Sunday to Thursday UTC is Monday to Friday there.

| When (UTC)     | Bot               | Routine            | Speaks                                    |
| -------------- | ----------------- | ------------------ | ----------------------------------------- |
| `0 20 * * *`   | main              | box health         | only when something is wrong              |
| `0 20 * * 0-4` | chief-of-staff    | morning brief      | always, that is the point                 |
| `0 21 * * 0-4` | qa                | weekday health     | only when something is wrong              |
| `0 2,14 * * *` | qa                | production smoke   | only when something is broken             |
| `0 21 * * 6`   | software-engineer | Sunday hygiene     | only when something needs a person        |
| `0 22 * * 0`   | pm                | weekly funnel scan | only when a test is due or a number moved |
| `0 22 * * 0`   | seo               | Search Console     | only on a drop or an error                |

Silence is the design. One "all good" a day from eight Bots is eight
messages nobody reads, and the ninth one matters.

A routine lives in the Bot's own `agent/schedules/`, and the same cron is
written again in `agent/routines.json` because a sleeping Bot cannot fire its
own: the hub reads that file and wakes the Bot a minute before it is due. The
two copies are pinned together by a test, so adding a schedule without
declaring it fails the build rather than quietly never running.

**A suspended Machine has no clock, so the clock is outside it.** This
computer suspends to zero when nobody is using it, and nothing inside a
suspended guest runs: not the hub's alarm, not a Bot's croner. So there are
two alarms. The outer one is `apps/clock`, a 256 MB always-on Fly app that
holds no credential and does one thing: three minutes before any routine
minute it GETs the computer's public `/healthz`, which is a request, and a
request through Fly Proxy starts the Machine. The inner one is the hub's,
which then wakes the Bot, and the Bot's own croner fires the routine. The
clock keeps pinging while the box answers `busy`, so Fly does not suspend the
guest underneath a turn that is still running.

Three things follow. The clock reads the routine manifests out of its own
image, so **a routine change is two deploys**: the guest and the clock
(`docs/DEPLOY.md`). The clock is now the single point of failure for every
routine on every computer, which is why it has a health check that fails when
it has no schedule or no targets: read `/healthz` on it to see the next
firings it is actually waiting for. And a routine whose minute passes while
the clock itself is down is still missed and still not caught up: firing one
late would mean telling a Bot to run it, which needs a credential and a route
into the box, and the clock holds neither on purpose. The failure is rarer,
not gone.

## What a Bot costs

Measured idle on this guest: a Bot's Eve is 224 MB, and a claimed screen
(Xvfb, openbox, x11vnc and a Chromium) is about 430 MB. Eight of each is
5 GB and the Machine has 2, which is Fly's ceiling for one that can suspend
to zero. So a Bot sleeps when nobody needs it, and sleeping is complete: no
process and no screen.

| What wakes one                              | What it costs while awake |
| ------------------------------------------- | ------------------------- |
| You open its chat, or a webhook fires       | its Eve, about 224 MB     |
| It touches its screen, or you open the desk | its window, about 430 MB  |
| A routine is a minute from due              | the same, for the turn    |

A routine also costs the Machine itself: the clock holds the guest up for ten
minutes per wake, and longer while the box says it is busy, capped at an hour.
Seven routines a day is a few hours of uptime a day, not a day of it.

A Bot goes back to sleep 20 minutes after the last thing it did (30 after a
routine woke it), and its screen is released after 30 minutes of nothing
touching it. Waking is about a second, which you see as the first message of
the day taking a beat.

There are also ceilings, because idling out is not enough on its own: two
Bots awake at once and two screens up at once, the primary Bot's included. Ask
for a third and the one used longest ago goes back to sleep. A screen someone
is at, or a Bot in the middle of a turn, is never the one taken.

The primary Bot (`main`) never sleeps: it is the desk the box boots with and
the Bot a human reaches without asking for anyone.

## Doors

QA has an incident webhook (`agent/channels/incident.ts`). Point an alerting
system at it with a connector:

```sh
npm run bot -- connector add <id> incident qa
# POST https://<computer>/connectors/<id>/event   header: x-connector-secret
```

The payload is treated as a stranger's text: fenced, never obeyed. See
[`apps/eve/README.md`](../apps/eve/README.md) for the shape and the rules.

## Sharing a Bot

A Bot you have shaped is worth handing to someone else, and describing it is
not the same as handing it over. **Share as Template** in a Bot's settings
reads its whole setup off the computer (`Seat.ExportBotTemplate`), shows it
with a switch beside each section, and publishes what you tick to a link on
hello.expert: `/bot/<id>`.

**It is made generic first, by default.** Your Bot is full of you: its brief
names your product, its skills name your repository, its memory is a list of
facts about you. So the computer rewrites it for a stranger before you see
it, keeping the job and dropping the parts that only make sense for you, and
says in one line what it left out. Turn it off and you share your Bot exactly
as it is, which is what a backup wants and not what a link does.

Three more things about what travels. **No credential does**: a plugin is the
address of a service and how it authenticates, so whoever installs it signs
in as themselves. **Memory never travels in a generic template**, and starts
off even in a verbatim one, because it is the Bot's record of the person it
works for. And nothing names the computer it came from.

Opening the link shows the same detail the publisher saw: the instructions in
full, the facts, the skills and their triggers, the routines and their
schedules, the plugins it wants. **Add Bot** then makes a Bot on the
reader's own computer, from their own browser with their own seat:
`CreateBot`, then `ApplyBotTemplate`, which is the New Bot sheet plus a
document. hello.expert stores the template and counts the installs; it never
holds a seat on someone's behalf to write to a hub.

The link is the whole credential, so it is unlisted rather than public, and
it stays yours: **Update from this Bot** re-reads the Bot into the same link,
and deleting the template turns the link off. Bots already made from it are
untouched, because a Bot on someone else's computer is theirs from the
moment it is made.

## Changing one

Three places, and they are not interchangeable:

- **Chat.** Ask the Bot. `write_file` reaches `/workspace` and nothing else,
  so what it can rewrite is its own profile, its memory and its notes, live on
  its next turn. Its instructions and skills are in the image at
  `/opt/computer` and compiled into its build, so those are a deploy.
- **The settings panel** at hello.expert writes the profile
  (`/workspace/.bots/<id>/profile.json`): name, label, description, mark.
  That file wins over the shipped seed forever after. **Share as Template**
  on the same panel is the other direction: it reads the whole setup out.
- **Installing a template** writes the brief, the skills, the routines and
  the plugin list into `/workspace/.bots/<id>/`, and those win over what the
  Bot's project ships, for the same reason the profile does.
- **This repository** is where instructions, skills, schedules and channels
  live. Those need a build and a deploy, which is the point: they are the
  Bot, not its preferences.
