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

Every one of them opens **draft** pull requests and none of them merges,
deploys, or sends anything live. That line is in each Bot's hard rules
because it is the rule a human is trusting when they let eight agents share
one signed-in computer.

## What they share

`/workspace` is one filesystem, and the Bots use it as the handoff:

| Path                         | Written by            | Read by                        |
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

- **Chat.** Ask the Bot. It edits its own files with `write_file` and the
  change is live on its next turn, and gone on the next deploy if it was in
  the image.
- **The settings panel** at hello.expert writes the profile
  (`/workspace/.bots/<id>/profile.json`): name, label, description, mark.
  That file wins over the shipped seed forever after.
- **This repository** is where instructions, skills, schedules and channels
  live. Those need a build and a deploy, which is the point: they are the
  Bot, not its preferences.
