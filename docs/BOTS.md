# The Bots on this computer

One computer, eight screens, eight Bots. Each one is a directory under
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

**A suspended Machine has no clock.** This computer suspends to zero when
nobody is using it, and neither the hub's alarm nor a Bot's own croner runs
while it is suspended, so a routine whose time passes on a sleeping box does
not fire and is not caught up afterwards. That is true today for `main`'s
daily check and it is true for all seven. Closing it means either keeping one
Machine running (`min_machines_running = 1`, and the suspend saving goes with
it) or something outside pinging the box a minute before each routine. Until
then, treat routines as "runs when the computer is up".

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

## Changing one

Three places, and they are not interchangeable:

- **Chat.** Ask the Bot. `write_file` reaches `/workspace` and nothing else,
  so what it can rewrite is its own profile, its memory and its notes, live on
  its next turn. Its instructions and skills are in the image at
  `/opt/computer` and compiled into its build, so those are a deploy.
- **The settings panel** at hello.expert writes the profile
  (`/workspace/.bots/<id>/profile.json`): name, label, description, mark.
  That file wins over the shipped seed forever after.
- **This repository** is where instructions, skills, schedules and channels
  live. Those need a build and a deploy, which is the point: they are the
  Bot, not its preferences.
