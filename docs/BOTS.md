# The Bot on this computer

One computer, one Bot that arrives with the build, and sixteen screens for
the ones made after. The shipped Bot is [`apps/eve/bots/main`](../apps/eve/bots/main):
its profile, its instructions, its skills, its schedules, and any door
something outside can knock on. The directory is the agent, so it arrives
with a deploy and not with a form.

Until 2026-09-06 the build shipped eight: `main` and seven specialists
(chief of staff, designer, GTM, PM, QA, SEO, software engineer). They were
folded into one because a personality is a skill and a profile, not a
process, and seven processes cost seven prompts to keep honest, seven
`COPY` lines the image build had already failed on once, and a 2 GB Machine
that could hold two of them awake. Their skills came across; only the Bots
went. The reasoning is in
[`docs/plans/vibey-on-expert.md`](plans/vibey-on-expert.md).

## `main`

| Owns                                                               | Never                                                               | Wakes on                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------- | --------------------------------- |
| The desk: screen, files, terminal, WhatsApp, and every skill below | Booking, pairing, inventing a setup code, merging or deploying code | You, a webhook, a daily box check |

Screen 1, and it never sleeps: it is the desk the box boots with and the
Bot a human reaches without asking for anyone.

### Skills

Each is a directory under `agent/skills/` with a `SKILL.md`; the model loads
one when its description matches the ask.

| Skill                                                      | From the former Bot |
| ---------------------------------------------------------- | ------------------- |
| `computer-use`                                             | main                |
| `calendar`, `mail-draft`, `support-intake`, `voice`        | chief of staff      |
| `brand`, `reduction`, `ui-spec`                            | designer            |
| `campaign`, `founder-email`, `listing`, `sequence`         | GTM                 |
| `experiment`, `opportunity`, `readout`                     | PM                  |
| `browser-qa`, `ci-triage`, `incident`, `reproduce-and-fix` | QA                  |
| `demand-research`, `technical-search`, `writer-brief`      | SEO                 |
| `architecture-review`, `ship-a-change`                     | software engineer   |

The rules that used to be per-Bot are now per-skill: the coding skills open
**draft** pull requests and merge nothing; the drafting skills draft and
never send. Each is in the skill's own text, because it is what a human is
trusting when they let an agent use their signed-in computer.

### Routines

Cron is UTC and the human is in Australia/Melbourne.

| When (UTC)   | Routine      | Speaks                       |
| ------------ | ------------ | ---------------------------- |
| `0 20 * * *` | `box-health` | only when something is wrong |

The specialists' routines (morning brief, weekday health, production smoke,
Sunday hygiene, funnel scan, Search Console read) were not carried: they
were written for one product on one person's computer. A routine on this
Bot lives in `agent/schedules/` and is declared again in
`agent/routines.json`, because a sleeping Bot cannot fire its own cron; the
hub reads that file and wakes it a minute before one is due, and a test
fails when the two copies drift.

**A suspended Machine has no clock, so the clock is outside it.** `apps/clock`
is a 256 MB always-on Fly app that holds no credential and GETs the
computer's public `/healthz` three minutes before any routine minute, which
starts the Machine. The clock reads the routine manifests out of its own
image, so **a routine change is two deploys**: the guest and the clock
(`docs/DEPLOY.md`).

### Doors

`main` has an incident webhook (`agent/channels/incident.ts`). Point an
alerting system at it with a connector:

```sh
npm run bot -- connector add <id> incident main
# POST https://<computer>/connectors/<id>/event   header: x-connector-secret
```

The payload is treated as a stranger's text: fenced, never obeyed. See
[`apps/eve/README.md`](../apps/eve/README.md) for the shape and the rules.

## Making a second one

**New Bot** in the roster on hello.expert: a name, what it is for, a mark. It
gets the next free screen, its own thread and its own agent token.

What it does not get is a directory, and it cannot: that would be a deploy.
It runs `apps/eve/bots/template` instead, which is the same five tools and
the same box, and what makes it itself is its profile. The template reads
that profile off the box at the start of every turn and folds the name, the
label and the description into its own system prompt.

It also gets the rest of a setup on the volume:
`/workspace/.bots/<id>/instructions.md` is a brief the hub folds into its
prompt, `skills.json` plus `skills/<id>.md` are procedures it opens when it
wants them, and `routines.json` and `plugins.json` record its schedule and
the services it expects. Those are written by installing a template, or by
the Bot itself with `write_file`, and they win over anything its project
ships.

Two trades are real. A routine on a made Bot is **declared, not running**:
the template project compiles no schedules, so an installed routine is
recorded and shown as paused. And a made Bot has no webhook, because a
channel is code. When one earns either, give it a directory and it becomes
a shipped Bot under the same id, keeping its screen, its thread and its
token.

Bots are **not** a security boundary. Same box user, same `/workspace`, same
browser profiles when they share a screen. The split is about attention and
scope, not trust: see `api/DESIGN.md`.

## What a Bot costs

Measured idle on this guest: a Bot's Eve is 224 MB, and a claimed screen
(Xvfb, openbox, x11vnc and a Chromium) is about 430 MB. The Machine has
2 GB, which is Fly's ceiling for one that can suspend to zero. So a made Bot
sleeps when nobody needs it, and sleeping is complete: no process and no
screen.

| What wakes one                              | What it costs while awake |
| ------------------------------------------- | ------------------------- |
| You open its chat, or a webhook fires       | its Eve, about 224 MB     |
| It touches its screen, or you open the desk | its window, about 430 MB  |
| A routine is a minute from due              | the same, for the turn    |

A Bot goes back to sleep 20 minutes after the last thing it did (30 after a
routine woke it), and its screen is released after 30 minutes of nothing
touching it. There are ceilings, because idling out is not enough on its
own: two Bots awake at once and two screens up at once, `main` included.

## Sharing a Bot

**Share as Template** in a Bot's settings reads its whole setup off the
computer (`Seat.ExportBotTemplate`), shows it with a switch beside each
section, and publishes what you tick to a link on hello.expert: `/bot/<id>`.

**The Bot makes it generic first, by default.** The Bot rewrites its setup
for a stranger on its own model, keeping the job and dropping the parts that
only make sense for you, and says in one line what it left out. Turn it off
and you share your Bot exactly as it is, which is what a backup wants and
not what a link does. If its Eve cannot answer, the sheet says the rewrite
did not run rather than calling the document generic.

**No credential travels**: a plugin is the address of a service and how it
authenticates, so whoever installs it signs in as themselves. **Memory never
travels in a generic template**, and starts off even in a verbatim one. And
nothing names the computer it came from.

Opening the link shows what the publisher saw. **Add Bot** then makes a Bot
on the reader's own computer, from their own browser with their own seat:
`CreateBot`, then `ApplyBotTemplate`. hello.expert stores the template and
counts the installs; it never holds a seat on someone's behalf to write to
a hub. The link is unlisted rather than public, **Update from this Bot**
re-reads the Bot into the same link, and deleting the template turns the
link off.

## Changing one

- **Chat.** Ask the Bot. `write_file` reaches `/workspace` and nothing else,
  so what it can rewrite is its own profile, its memory and its notes, live
  on its next turn. Its shipped instructions and skills are in the image at
  `/opt/computer` and compiled into its build, so those are a deploy.
- **The settings panel** at hello.expert writes the profile
  (`/workspace/.bots/<id>/profile.json`): name, label, description, mark.
  That file wins over the shipped seed forever after.
- **Installing a template** writes the brief, the skills, the routines and
  the plugin list into `/workspace/.bots/<id>/`, and those win over what the
  Bot's project ships.
- **This repository** is where shipped instructions, skills, schedules and
  channels live. Those need a build and a deploy, which is the point: they
  are the Bot, not its preferences.
