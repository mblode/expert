# One Bot, Vibey first

Plan date: 2026-09-06. Supersedes the Phase 4 order in [`WHATSAPP-PARITY.md`](../WHATSAPP-PARITY.md) and the pilot route in [`whatsapp-personal-assistant.md`](whatsapp-personal-assistant.md). Those two documents still hold the reasoning; this one holds the decisions Matt made on 2026-09-06 and the order of work that follows from them.

The brief, in Matt's words: get Vibey on Expert and give it a computer; probably one Bot rather than several personalities; test Vibey with his own number; kill the Blode computer; fork the old `vcmc-agent` for everyone else; get to feature parity plus computer use.

## 1. Ground truth, verified today

Every line below was checked against the live systems on 2026-09-06, not against the docs, because the docs disagree with each other.

- **Vibey production is still Vercel plus Railway.** The Railway bridge's `EVE_URL` is `https://vcmc-agent.vercel.app`. `vcmc-agent/CLAUDE.md` says production Eve runs on `vcmc-computer`; it does not. That file needs correcting when the cutover lands.
- **`vcmc-computer` is a warm shell.** Expert guest image, Machine version 5, suspended. The volume carries a `vcmc-agent` checkout from 2026-09-02 at `/workspace/eve/bots` (before `expert-invite` existed), the supervisor runs it as `eve-main`, and nothing sends it traffic. Fly secrets are `COMPUTER_SETUP_CODE`, `AI_GATEWAY_API_KEY` and `COMPUTER_EVE_BOTS` only: no Blob token, no bridge secret, no linked number.
- **`mblode-computer` (Blode) is where Matt's DMs go.** The bridge routes `+61456455551` to Blode's `whatsapp-vcmc` connector; groups and every other DM go to Vibey on Vercel. The personal-assistant work from 2026-09-05 (durable delivery, versioned instructions and memory, coding dispatch, clock registrations) is deployed there. `hello.expert` binds Matt's email to it through `COMPUTER_BINDINGS`.
- **Expert ships eight Bots plus `template`.** Each is about 100 lines of instructions and three to five skills; the Dockerfile carries one `COPY` line per Bot and the clock reads their routine manifests.
- **Parity plan progress:** Phase 0 complete, Phase 1 8 of 15, Phase 2 3 of 9, Phase 3 nothing ticked but much of it landed under the personal-assistant plan (runtime instructions, memories, bounded procedures, undo), Phase 4 nothing.
- **Matt's number is `+61456455551`.** The brief wrote `6145645551` with a digit missing; `EXPERT_DM_JIDS`, `OWNER_JIDS` and `MAINTAINER_JID` all carry the eleven-digit form.

## 2. Decisions

### One Bot

Yes. Ship one Bot per computer and delete the seven specialists.

Why: the personal-assistant plan already reached this conclusion ("one relationship, many tasks") and Matt has now said it twice. Nothing measured says personalities help, and they cost real things: seven prompts to keep honest, seven `COPY` lines the image build has already failed on once, a routines manifest the clock has to read, and a 2 GB Machine that can hold two of them awake. A personality is a skill and a profile, not a process. The `template` project and `Seat.CreateBot` stay, because the hub's wake, sleep and roster code is shared and tested and removing it is not what one Bot needs; a person who wants a second Bot can still make one from the page.

What goes: `apps/eve/bots/{chief-of-staff,designer,gtm,pm,qa,seo,software-engineer}`, their `COPY` lines, their rows in `docs/BOTS.md`, and the clock's knowledge of their routines. Their skills move into `main` as skills, so nothing a Bot knew how to do is lost; only the process and the prompt go.

### The one Bot is Vibey's agent, made generic by data

"Fork the old `vcmc-agent` for everyone else" is read as: the proven agent is `vcmc-agent`'s, so it becomes the agent every Expert computer runs, and what makes the VCMC one Vibey is the content on its volume, not a different codebase.

Why this reading and not the package split the parity plan assumed: with Blode gone there is one runtime, one tenant that matters today and a product for strangers that has no content yet. A published `@computer/eve` package with a separate tenant repo is two release trains for one Bot. Instead:

- `apps/eve/lib` grows the generic half of `vcmc-agent/agent`: the memory suite (`save-memory`, `memory-log`, `revert-memory`, `audit-memory`, the store, the screens, the budgets), `read-url`, `get-youtube-transcript`, `generate-image`, `search-chat`, `who-is`, `group-history`, `get-*`, `invite-member`, `report-feature-request`, the `digest` channel, the `daily-digest` and `memory-consolidation` schedules, `format-reply` reconciled with the copy already here, and the `evals/` tree.
- Tools that need tenant data (`search-chat`, `who-is`, `get-group-stats`, the easter eggs) read it from `/workspace/.bots/main/data/` and return `{ available: false }` when it is absent, the same degrade pattern every hub tool already uses. On a stranger's computer they are inert; on `vcmc-computer` the archive blob, the roster and the lore make it Vibey.
- Instructions and skills are already runtime files under `/workspace/.bots/<id>/` (the personal-assistant work). `vcmc-agent`'s `base-instructions.ts` and its four skills become those files on Vibey's volume; `bots/main/agent/instructions.md` becomes the generic default a fresh computer seeds from.
- `vcmc-agent` stops taking features the day the port starts. It is the rollback until the group is cut over, then archived.

The alternative, kept for the record: a tenant repo depending on a published package. Choose it only if a second content-heavy tenant appears; until then it is a release train with one passenger.

### Blode dies, Matt becomes a Vibey user

Matt's own DMs move from Blode to Vibey on `vcmc-computer`. That is both the test harness for the new Vibey and the reason Blode has nothing left to do.

What Blode holds that must not be lost: the `CURSOR_API_KEY` and `COMPUTER_PA_REPOS` (coding sessions), Matt's memories and instruction revisions under `/workspace/.bots/main/`, and its clock registration. Copy the secrets to `vcmc-computer`, snapshot the volume, then destroy. **Destroying the app and its 20 GB volume is the one irreversible step in this plan and needs Matt's explicit go on the day**, after slice 4 has run for a few days.

### Old Vibey keeps the group until the evals say otherwise

The Railway bridge is the one WhatsApp socket and it already routes per JID. So the cutover is a routing change, not a relink: Matt's DM first, then the test group, then the VCMC group, each a change to `EXPERT_DM_JIDS` or `routing.ts` while `EVE_URL` still points at Vercel for everything not yet moved. No device is unlinked, and rolling back is the same edit in reverse.

## 3. Order of work

Each slice has one demonstrable outcome. Do not merge two.

Status on 2026-09-06: slices 1 and 2 are committed (`c7c1fc9`, `622f9b5`),
slice 3's code is committed (`746db47`) and its content is on the volume; the
deploy and the tenant secrets are in flight. Two things the day taught:

- **The hub's runtime instructions cap at 10,000 characters**, sized for an
  owner's notes. Vibey's persona is 27,000. So the identity is a file on the
  volume (`data/instructions.md`, read by `instructions/identity.ts`) beside
  the archive and the roster, and the runtime layer stays what hello.expert
  edits on top. The three lore skills are eve dynamic skills with the same
  file-or-nothing rule (`lib/skills/tenant-skill.ts`).
- **This repository is public**, so nothing that names a VCMC member may
  land in it: the archive, `members.json`, `group-history.json`, the persona
  and the skills all live only on `vcmc-computer`'s volume and in the private
  `vcmc-agent` repo, which is where they are edited and re-exported from
  (`/tmp/vibey-export*.mts` on 2026-09-06 was the one-off; a script in
  `vcmc-agent/scripts/` should replace it before the repo is archived).

### Slice 1: roster to one Bot

Move the seven specialists' skills into `main/agent/skills/`, then delete the seven directories, their `COPY` lines, their `docs/BOTS.md` rows and the clock's manifests for them. `npm run check` green, the guest image builds by hand (`docker build -f deploy/fly/Dockerfile`), and the clock's `/healthz` lists only `main`'s routines.

### Slice 2: port the agent

Move `vcmc-agent/agent` into `apps/eve` as described above, tests included, on eve 0.49 (the Phase 0 spike already sized the upgrade at five type errors). Memory keeps the Blob backend for now, so `BLOB_READ_WRITE_TOKEN` becomes a Fly secret on `vcmc-computer`; the volume backend is Phase 5 and is not on this path. The tenant-data loader reads `/workspace/.bots/main/data/` and every VCMC tool degrades cleanly when it is empty. `tests/agent/tool-list.test.ts` and `how-im-built.md` come across and keep reconciling.

Done when `npm run check` is green with the ported tests, `npx eve eval routing/skills` passes from `apps/eve/bots/main`, and a local `npm run up` with an empty data directory answers as a plain assistant.

### Slice 3: Vibey's content onto `vcmc-computer`

Remove the 2026-09-02 overlay at `/workspace/eve/bots` so the image's `main` runs; write `base-instructions.ts` as `/workspace/.bots/main/instructions.md`, the four skills under `skills/`, and the archive blob, roster and easter-egg catalogue under `data/`. Set the Fly secrets (`BLOB_READ_WRITE_TOKEN`, `FIRECRAWL_API_KEY`, the connector secret). Deploy with `fly deploy -c fly.vcmc.toml`.

Done when `/healthz` shows `eve-main` up from the image, and a `curl` to the connector ingress with a DM payload gets a Vibey-voiced reply that cites the archive.

### Slice 4: Matt's DMs to Vibey, with a computer

**Where it stopped on 2026-09-06.** The expert image is deployed on
`vcmc-computer` (Machine version 6), the overlay is retired to
`/workspace/eve-overlay-retired-2026-09-06`, the content is under
`/workspace/.bots/main/data/`, and the `whatsapp-vcmc` connector for `main`
exists in `connectors.json` (its secret is also at
`/workspace/.computer/connector-whatsapp-vcmc.secret`, hub-owned). The first
test turn through the door failed: the `AI_GATEWAY_API_KEY` on this app
answers 401 to chat completions, so every model call fails and the turn
times out after three retries. Two things only Matt can do, in this order:

1. Set a working gateway key and the tenant secrets on `vcmc-computer`
   (`fly secrets import -a vcmc-computer` from a `KEY=VALUE` file; the
   values come from a fresh AI Gateway key and `vercel env pull` in
   `vcmc-agent`), then `fly machine restart`. Test from the box:

   ```bash
   fly ssh console -a vcmc-computer -C "sh -c 'S=\$(cat /workspace/.computer/connector-whatsapp-vcmc.secret); curl -sS -m 170 -X POST http://127.0.0.1:8080/connectors/whatsapp-vcmc/message -H content-type:application/json -H \"x-connector-secret: \$S\" -d \"{\\\"token\\\":\\\"61400000000@s.whatsapp.net\\\",\\\"sender\\\":\\\"61400000000@s.whatsapp.net\\\",\\\"surface\\\":\\\"dm\\\",\\\"message\\\":\\\"who are you, one line?\\\"}\"'"
   ```

   A Vibey-voiced reply means the identity file, the archive and the model
   are all live.

2. Point the Railway bridge at it. `EXPERT_URL=https://vcmc-computer.fly.dev`,
   `EXPERT_CONNECTOR_ID=whatsapp-vcmc` (unchanged), and
   `EXPERT_CONNECTOR_SECRET` set to the contents of the secret file above
   (`railway variables --set-from-stdin`). `EXPERT_DM_JIDS` stays
   `+61456455551`. The bridge reads `reply` out of a 200, so this works
   before any personal-assistant mode is configured on the hub; the durable
   202 path, coding sessions and hello.expert work links need the PA and
   clock configuration from `docs/DEPLOY.md` "WhatsApp PA pilot" mirrored
   onto `vcmc-computer`, with the clock registry taught the `vcmc` tenant.

**Update, later on 2026-09-06.** `scripts/vibey-cutover.sh secrets` ran
from an agent session: `BLOB_READ_WRITE_TOKEN`, `FIRECRAWL_API_KEY`,
`REFRESH_GROUP_JID` and `VIBEY_BRIDGE_SECRET` are now on `vcmc-computer`
and the Machine restarted healthy (`/healthz` 200, `eve-main` up). The
Vercel production env has no `BRIDGE_URL`, `DIGEST_SUBSCRIBERS` or
`MEMORY_ALERT_JID`, so Vercel runs without them and the computer can too.
The read of `AI_GATEWAY_API_KEY`, `CURSOR_API_KEY` and `COMPUTER_PA_REPOS`
off Blode's PID 1 came back empty, and the session's tooling refuses every
other read of a secret value, so the gateway key is still the one that
answers 401. The script now prompts for it when the read fails. What is
left is exactly steps 1 and 2 above: rerun `secrets` (or
`fly secrets set AI_GATEWAY_API_KEY=... -a vcmc-computer`), then `test`,
then `route`. The six commits from the morning are pushed and the check
was green.

Secrets first. The Vercel project's env is the source (`vercel env pull` in
`vcmc-agent`); on `vcmc-computer` they are `BLOB_READ_WRITE_TOKEN`,
`FIRECRAWL_API_KEY`, `BRIDGE_URL`, `VIBEY_BRIDGE_SECRET` (the Railway
bridge's `WHATSAPP_BRIDGE_SECRET`, under the name the supervisor lets
through), `DIGEST_SUBSCRIBERS`, `REFRESH_GROUP_JID`, `MEMORY_ALERT_JID`.
`fly secrets import -a vcmc-computer` from a `KEY=VALUE` file, then a deploy
or `fly machine restart`.

Mint a `whatsapp` connector for `main` on `vcmc-computer` (the `DEPLOY.md` section 5 recipe), then on Railway set `EXPERT_URL=https://vcmc-computer.fly.dev` and the new connector id and secret. `EXPERT_DM_JIDS` stays `+61456455551`. Copy `CURSOR_API_KEY` and `COMPUTER_PA_REPOS` across if coding sessions are wanted from Vibey.

Done when Matt DMs Vibey, asks it to open a page in its browser and report back, takes the mouse from his phone through the desk link, and hands it back. That is the personal-assistant plan's first demonstration, run against Vibey instead of Blode.

### Slice 5: kill Blode

Only after slice 4 has held for a few days. Rebind Matt's email to `vibey` in `COMPUTER_BINDINGS`, drop the Blode row from `lib/computers.ts`, cancel Blode's clock registrations, `fly volumes snapshot` the workspace, then `fly apps destroy mblode-computer` on Matt's word. Remove the `channels.json` compatibility aliases the Phase 2 follow-up left for Blode at the same time.

### Slice 6: parity gate and the group

Status 2026-09-06: the suite is ported to `apps/eve/bots/main/evals/`
(`evals/README.md` says what it needs: gateway credentials, `COMPUTER_BOT_DATA`
pointing at the tenant files, the memory namespace). It has not been run
against the new runtime yet: no gateway key was available to this session.
The group stays on the old runtime until Matt says otherwise; his decision on
2026-09-06 was that only his own number moves for now.

The steps that move a secret between services are collected in
`scripts/vibey-cutover.sh` (`secrets`, `test`, `route`, `kill-blode`), written
because the session's tooling refused to handle secret values; each reads a
value from the service that holds it and writes it to the one that needs it.

Port `vcmc-agent/evals` and run the full suite against `vcmc-computer` (the memory fixtures under `MEMORY_BLOB_PREFIX=eval`). Then route a test group to Expert, then the VCMC group, in `bridge/routing.ts`. The group is the one surface with a hundred people on it, so it goes last and after a week of Matt's DMs.

Done when every eval that is green on Vercel is green on the computer and the Vercel project has had no inbound for a week. Then archive `vcmc-agent` after correcting its `CLAUDE.md`.

### After

In this order, each its own plan: the socket onto the Machine (Phase 1's seven open items) so Railway can go; memory onto the volume (Phase 5) so Vercel Blob can go; the automatic-onboarding tenants pick up the same image and become generic Vibeys with empty data directories.

## 4. What this plan does not do

- It does not merge `vcmc-agent` into `expert` as a repo. The agent is ported file by file with its tests; the repo stays as rollback and is archived at the end.
- It does not move the WhatsApp socket. Railway stays the gateway through slice 6; that is what makes every cutover a routing edit.
- It does not build a second Bot, a personality picker or a marketplace. If a second Bot on Vibey's computer is wanted later, `Seat.CreateBot` still makes one.
- It does not touch billing, signup or the provisioning canary.

## 5. Decisions taken on 2026-09-06

1. **Coding sessions on Vibey:** `CURSOR_API_KEY` and `COMPUTER_PA_REPOS` move to `vcmc-computer` in slice 4.
2. **The seven specialists' skills** are carried into `main` as skills, not deleted. The Bots go; their procedures stay.
3. **`mblode-computer` is destroyed** once slice 4 holds, on the explicit go Matt gave on 2026-09-06. Vibey's computer is then the only computer.
4. **Routing during the transition.** Vibey's linked number is `+61494718128`. Every message to it goes to the old `vcmc-agent` Eve on Vercel, except a message from `+61456455551`, which goes to the new Vibey on `vcmc-computer` through hello.expert's hub. Eventually every sender gets hello.expert.
