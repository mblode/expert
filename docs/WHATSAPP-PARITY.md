# WhatsApp parity: Vibey as one tenant of Expert

Plan date: 2026-09-02. Companion to [`GROK-BOT.md`](GROK-BOT.md) (the product target) and [`AUDIT.md`](AUDIT.md) (the open findings). This document is the order of work for making Expert the thing that runs Vibey, with WhatsApp group and DM as one channel of one Bot on one tenant computer, and computer use, plugins, routines, skills and instructions all editable from that chat or from hello.expert.

Scope rule from Matt: **do not merge `vcmc-agent` into `expert` yet.** `vcmc-agent` keeps its repo, its bridge on Railway and its production deployment until Phase 4 cuts it over onto the runtime this plan builds. Everything generic (the channel, the bridge, invites, plugins, routines, self-update) is built in `expert`; everything VCMC-specific (the archive, the lore, the persona, the member data, the digest prompts) stays tenant content in `vcmc-agent`.

## 1. Is the picture right?

The picture as stated: Expert runs Eve on a persistent Linux computer with computer use, the agent updates its own files, drives a real browser, and WhatsApp is just a channel. Yes, with five corrections that shape the plan. Each one is a real gap today, not a nuance.

1. **Eve does not hot-reload in production.** `eve start` serves the previously built `.output/`; only `eve dev` watches files. An agent that edits `agent/skills/foo.md` on disk with `write_file` changes nothing until someone runs `eve build` and restarts the process. The documented route to runtime self-update is `defineDynamic` resolvers (instructions, skills, connections, tools, model, subagents) that read a data store at `session.started`, plus the dynamic-scheduling dispatcher pattern for routines. So "self-updating files" has to mean: the Bot's editable surface is **data files a deployed resolver reads**, and code changes (new TypeScript tools, channels, `agent.ts`) go through a supervised rebuild and restart. Section 3 draws that line.
2. **On the Expert guest, the hub is the only public door.** `fly.vcmc.toml` exposes the hub on `:8080`; Eve is loopback on `:2000` and reachable only through `/eve/v1`, which requires a hello.expert seat token. The Railway bridge cannot reach `POST /eve/v1/whatsapp/message` on that box. `vcmc-agent`'s own `fly.toml` solves it by exposing Eve directly on `:2000`, which is a different image on the same Fly app and bypasses the hub, the policy gate and the wake path. The channel needs a hub ingress.
3. **hello.expert only knows account holders, and every seat is a box owner.** VCMC members do not sign in. `expert-invite` in `vcmc-agent` already posts to `https://hello.expert/api/invite`, which does not exist. Linking out from WhatsApp to "take the mouse" or "add a plugin" needs single-use, expiring, display-scoped guest seats, which means seat tokens with scope and expiry (AUDIT P0 #3) first.
4. **Vibey's memory, audit log and episodes live on Vercel Blob, and its model calls go through the Vercel AI Gateway.** Neither is on the computer. Parity "all inside expert" ends with memory on the tenant volume behind the same screens (`looksLikeDirective`, category caps, fence escaping, log, revert). That is Phase 5, not Phase 1, because the screens are the boundary and must move intact.
5. **Version and state skew.** `vcmc-agent` is on eve 0.30.6, `expert` on 0.47.6, current is 0.49.0 with deprecations (`defineInstructions({ markdown })`, channel `receive` renamed around `to(channel, target).send`). And Eve's durable run state lives under `.eve/.workflow-data` in the project directory, which for the image Bot at `/opt/computer/apps/eve/bots/main` is on the image, not the volume: a redeploy drops every in-flight and parked session. The overlay at `/workspace/eve/bots` is on the volume and does not have this problem.

## 2. First principles

Nouns, one sentence each, so the rest of the plan can use them without redefining.

| Noun         | What it is                                                                                                              | Where it lives                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Computer     | The tenant. One Fly app, one Machine, one volume, one hub, one setup code. VCMC is `vcmc-computer`.                     | `fly.<tenant>.toml`, `/workspace` on that volume                                 |
| Bot          | One Eve project directory and one screen. `main` on `:1` for Vibey.                                                     | `/workspace/eve/bots/<id>` (code), `/workspace/.bots/<id>` (state and config)    |
| Channel      | A way messages reach a Bot and replies leave it. WhatsApp, the hello.expert thread, a webhook. Not a persona.           | `agent/channels/<kind>.ts` in the generic runtime; per-tenant secrets in the hub |
| Plugin       | A remote MCP or OpenAPI connection with a credential a human consented to on hello.expert.                              | `plugins.json` (public descriptor) + hub-owned credential store                  |
| Routine      | A prompt on a cron in a timezone, delivered through a channel to a recipient, with run history and a test-run button.   | `routines.json`, dispatched by one schedule                                      |
| Skill        | A markdown procedure loaded on demand by `load_skill`. Adds instructions, never tools.                                  | `config/skills/<name>.md`                                                        |
| Instructions | The always-on prompt. Short and stable; long procedures are skills.                                                     | `config/instructions.md` + dynamic memory block                                  |
| Memory       | What the Bot authored about a chat. Per chat JID, screened on write, fenced on render.                                  | Blob today; the tenant volume after Phase 5                                      |
| Seat         | A human's grip on a screen. Owner seats come from sign-in; guest seats come from invites and expire.                    | Hub `seats.json`; scope and expiry are new                                       |
| Bridge       | The Baileys process that owns the WhatsApp socket, login and live tail. Transport for the WhatsApp channel, not a peer. | Railway now; a supervised guest process is a later option                        |

Invariants the plan holds to, because each one is a lesson already paid for in one of the two repos:

- **The directory is the agent** (eve.dev). A Bot is files. Anything a chat message may change is a data file a deployed resolver reads; anything that needs `eve build` is code and ships through the supervisor. No second registry, no database of instructions.
- **The hub is the door and the gate.** Every inbound message, every human input, every model action crosses the hub. A channel that bypasses it also bypasses policy, the seat FSM, suspend and wake, and the audit trail.
- **The model's tool surface stays five plus tenant tools.** `send_message`, `computer`, `shell`, `read_file`, `write_file` from `api/DESIGN.md`, then whatever the tenant adds (`search-chat`, `who-is`). Clipboard read, seat minting, VNC URLs and provisioning stay Seat RPCs. An invite is the one new agent-callable RPC, and it grants the model nothing (Section 4, Phase 2).
- **Secrets never appear in chat, on argv, in the model's context or in a tool result.** A WhatsApp reply carries a public URL or a one-line fallback, never a token; `sanitizeOutbound` in `vcmc-agent` already enforces this and the generic channel keeps it.
- **Bots are not security boundaries.** Same box user, shared `/workspace`. A tenant that needs isolation is a second computer, not a second Bot.
- **Never post to a group on a timer.** Proactive delivery is a DM to an allowlisted JID (`handleSend` refuses `@g.us`). A reply into the group that mentioned the Bot is a reply, not a broadcast, and Phase 3 gives it a scoped capability rather than widening the allowlist.
- **Human input is never RFB.** Mobile takeover is `Seat.Pointer` and `Seat.Type` over a view-only stream, same as iOS.

## 3. Target architecture

```
WhatsApp group / DM
     │  Baileys
     ▼
whatsapp-bridge (Railway, one per tenant number)
     │  POST https://vcmc-computer.fly.dev/channels/whatsapp/message   x-channel-secret
     ▼
hub :8080 (public door; wakes the Machine; checks channels.json)
     │  loopback, x-computer-eve-secret
     ▼
eve start :2000 for Bot main  ── Agent RPCs ──► hub ──► desk (Xvfb, Chromium, XTEST)
     │  reads /workspace/.bots/main/config/* at session.started
     │  BRIDGE_URL tools (messages, resources, send, send-media)
     ▼
reply: sync in the webhook response (Phase 1), async via bridge /send with a reply capability (Phase 3)

hello.expert (Vercel)
     ├─ owner: sign in → seat → chat, desk, Bot page (instructions, skills, routines, plugins), deploy
     └─ member: /i/<computer>/<code> → guest seat (15 min, one display) → mobile desk or plugin consent
```

On the volume, per Bot:

```
/workspace/eve/bots/main/              Eve project (code). Built by the supervisor. Git checkout for a tenant repo.
/workspace/eve/bots/main/.eve/         Eve build artefacts and .workflow-data (durable runs). Must be on the volume.
/workspace/.bots/main/                 Hub-owned state (exists today: profile.json, memory.md, transcript.jsonl)
/workspace/.bots/main/config/
  instructions.md                      always-on prompt, read by a dynamic instructions resolver
  skills/<name>.md                     read by a dynamic skills resolver
  routines.json                        read by the routines dispatcher schedule
  plugins.json                         id, url, description, instanceKey. No credentials.
  changes.jsonl                        who changed what, when, from which path (chat tool or hello.expert), revert id
/workspace/.bots/main/routines/<id>/runs.jsonl   last 20 runs: started, finished, status, transcript slice
/workspace/.computer/                  hub secrets: bots.json, seats.json, eve-secret, channels.json, plugins/<id>.cred
```

Hot versus cold, which is the whole design of self-update:

| Surface             | Path                                  | Mechanism                                                                                  | Rebuild? |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------ | -------- |
| Instructions        | `config/instructions.md`              | `defineDynamic` instructions at `session.started`, appends the memory block                | no       |
| Skills              | `config/skills/*.md`                  | `defineDynamic` skills returning a `defineSkill` map from the directory                    | no       |
| Plugins             | `plugins.json` + hub credential       | `defineDynamic` connections, `defineMcpClientConnection` per entry with `instanceKey`      | no       |
| Routines            | `routines.json`                       | one dispatcher `defineSchedule`, lease via a schedule store, deliver with `to(channel, …)` | no       |
| Model               | `profile.json.model`                  | `defineDynamic` model resolver                                                             | no       |
| Profile             | `profile.json`                        | hub `BotState`, already exists                                                             | no       |
| Tools, channels     | `agent/tools/*.ts`, `agent/channels/` | supervisor: fetch, `npm ci`, `eve build` in a staging dir, health check, swap, rollback    | yes      |
| `agent.ts`, sandbox | `agent/agent.ts`, `agent/sandbox.ts`  | same                                                                                       | yes      |

Two ways to edit, one set of files. The Bot edits through a typed `bot_config` tool (get and set on instructions, a skill, a routine, a plugin descriptor) that validates with zod, runs the directive screen and size caps from `vcmc-agent`'s memory path, appends to `changes.jsonl`, and answers "done" only after reading the file back. `write_file` stays as the escape hatch, and the resolvers validate on read so a malformed file degrades to the last good copy rather than a broken session. hello.expert edits through new Seat RPCs that write the same files and the same log. Grok's rule, "everything on the profile page is also set up through chat", falls out of that.

How the generic layer is shared without merging repos: `apps/eve/lib` becomes a published package (working name `@computer/eve`, subpath exports `./channels/whatsapp`, `./tools/*`, `./dynamic/*`, `./hub`, `./auth`), versioned with changesets and published from `expert` CI. `apps/eve/bots/main` consumes it the way it already re-exports from `../../lib`; `vcmc-agent` consumes it by pinning a version and re-exporting into its own `agent/` slots so tool names stay `computer`, not `expert__computer`. An eve extension package is the alternative; it prefixes names and cannot contribute `agent.ts`, memory or sandbox, so the re-export layout wins until that changes.

## 4. What parity means

Inventory of `vcmc-agent`, and where each piece lands.

| In `vcmc-agent` today                                                                                 | Lands in `expert` (generic)                                                       | Stays tenant content                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `agent/channels/whatsapp.ts` (payload, context fencing, media, empty-reply fallback, `outboundReply`) | `lib/channels/whatsapp.ts` + `lib/format-reply.ts`, bridge protocol versioned     |                                                  |
| `bridge/` (Baileys, trigger modes, mentions, media pipeline, transcription, HTTP API, allowlists, QR) | `apps/whatsapp-bridge`, tenant-agnostic, `members.ts` overlay becomes a JSON file | the VCMC member overlay data                     |
| `computer`, `shell`, `read_file`, `write_file`, `lib/hub.ts` (degrade to `available:false`)           | already `lib/tools/*`; adopt the degrade behaviour                                |                                                  |
| `expert-invite`                                                                                       | `lib/tools/expert_invite.ts` calling the hub, not a web URL                       |                                                  |
| `computer-use` skill                                                                                  | `bots/main/agent/skills/computer-use/SKILL.md`, one copy                          |                                                  |
| `instructions.ts` (base + memory block)                                                               | dynamic instructions resolver reading `config/instructions.md`                    | `base-instructions.ts` becomes the tenant's file |
| `easter-eggs`, `group-lore`, `how-im-built`, `matthew-blode` skills                                   | dynamic skills resolver                                                           | the skill files                                  |
| `daily-digest` schedule + `digest` channel                                                            | routines dispatcher + DM delivery through the channel                             | the digest prompts and subscribers               |
| `memory-consolidation` schedule                                                                       | stays a TypeScript schedule (tenant code) until memory moves                      | `consolidation.ts`, `stale-scan.ts`              |
| `save-memory`, `memory-log`, `revert-memory`, `audit-memory`, `memory-store.ts` (Blob)                | Phase 5: `MemoryStore` interface with a volume backend; screens unchanged         | categories, health scoring                       |
| `search-chat`, `get-group-stats`, `get-reactions`, `who-is`, `group-history`, archive blob, reingest  |                                                                                   | all of it                                        |
| `read-url`, `get-youtube-transcript`, `generate-image`                                                | candidates for the generic tool set later; not needed for parity                  | for now                                          |
| `report-feature-request`, `invite-member` (bridge `/report`, `/invite`, `MAINTAINER_JID`)             | bridge routes stay generic                                                        | the tools                                        |
| `evals/` (`eve eval`, routing, safety, voice)                                                         | an `evals/` for the generic channel: formatting, fencing, no-token-in-reply       | VCMC suites                                      |
| `deploy/fly` Eve-only image, `boot-eve.sh`                                                            | retired: the Expert guest image plus the supervisor is the deployment             |                                                  |
| Vercel project (fallback), Blob, AI Gateway                                                           | Phase 5 retires Vercel for the agent; the gateway key stays a Fly secret          |                                                  |

## 5. Phases

Each phase ships on its own and leaves production Vibey untouched until Phase 4. Todos are checkboxes with the file they land in. "Done when" is the exit test.

### Phase 0: prerequisites and ground truth

Nothing WhatsApp yet. This phase removes the five corrections from Section 1 that block everything after.

- [ ] Upgrade `expert` to eve 0.49.x (`apps/eve/package.json`, `apps/eve/bots/main/package.json`, `apps/web/package.json`); run `npx eve info` in `bots/main`; fix `defineInstructions` and channel API deprecations.
- [ ] Spike an eve 0.30.6 → 0.49.x upgrade of `vcmc-agent` on a branch: `npx eve info`, `npm test`, `npm run typecheck`, then `npx eve eval routing/skills`. Record every breaking change in `vcmc-agent/CHANGELOG.md` under Unreleased. Do not merge yet; this is the cost estimate for Phase 4.
- [ ] Put Eve's durable state on the volume: confirm where 0.49 writes `.eve/.workflow-data` and either run every Bot from `/workspace/eve/bots/<id>` (seed from the image on first boot in `guest-entrypoint.sh`) or point it at `/workspace/.bots/<id>/eve-state`. `apps/hub/src/host/eve.ts`, `deploy/fly/guest-entrypoint.sh`.
- [ ] Confirm durable runs complete behind the hub proxy: the self-hosting guide says a proxy restricted to `/eve/` stalls workflow callbacks on `/.well-known/workflow/`. Test a parked turn (an approval) resuming on the guest; if it stalls, forward that prefix in `apps/hub/src/handler/eve-proxy.ts` (seat-gated, loopback target).
- [ ] Supervisor for Eve children (AUDIT P1 #5): replace the detached `spawn` in `apps/hub/src/host/start-eves.ts` with a supervised child per Bot (restart with backoff, `/eve/v1/health` probe, log rotation), and make `/healthz` report per-Bot Eve health and the primary display. This is also the process the self-update rebuild hooks into in Phase 3.
- [ ] Seat tokens with scope and expiry (AUDIT P0 #3): `AuthRegistry` learns `{ token, kind: "owner" | "guest", display?, methods?, expires_at }`, `Seat.Revoke`, revoke on sign-out in `apps/web`, expiry sweep. Owner tokens keep today's behaviour. `packages/shared/src/index.ts`, `api/DESIGN.md`, `api/spec.json`, `api/computer.proto`, then `npm run proto:gen`.
- [ ] Hub UID split (AUDIT P0 #2): the hub runs as its own user owning `/workspace/.computer` at 0700; Eve gets its bot token from a per-Bot 0400 file or inherited fd. Required before any plugin credential is stored on the box. `deploy/fly/Dockerfile`, `deploy/fly/guest-entrypoint.sh`.
- [ ] `COMPUTER_SETUP_CODE` required as a Fly secret on non-private deployments; the entrypoint refuses rather than mints. `fly.vcmc.toml` comment already says so.
- [ ] Default `data/policy.json` shipped with `ask` on `apt`, `rm -rf`, `curl | sh`, and on `git`/`npm` inside `/workspace/eve` (AUDIT P1 #6). `apps/hub/src/service/policy.ts`.
- [ ] `api/DESIGN.md`: add the nouns from Section 2 (Computer, Bot, Channel, Plugin, Routine, guest Seat) and the ingress, invite and config RPCs this plan introduces, so later phases change the contract in one place. `api/spec.json` and `packages/shared` move with it.

Done when: `npm run check` is green on eve 0.49; a parked approval on the Fly guest resumes after a Machine restart; a guest seat token expires and `Seat.Revoke` works; a `shell` call to `apt-get install` from a routine returns `ask`.

### Phase 1: WhatsApp is a channel of Expert

The generic channel and the bridge, in `expert`, tested against a throwaway WhatsApp number and a test group. Vibey does not move.

- [ ] Hub channel ingress: `POST /channels/<channel_id>/<path>` in `apps/hub/src/handler/channels.ts`, authenticated by `x-channel-secret` against `/workspace/.computer/channels.json` (`{ id, bot, secret, paths[] }`), forwarded to that Bot's Eve at the listed path with `x-computer-eve-secret`. Body cap, no seat token accepted, `DAEMON_DOWN` if the Bot has no Eve. Lockout after repeated bad secrets like `Pair`. The Fly `http_service` on `:8080` already wakes a suspended Machine, so the bridge's POST is the wake path.
- [ ] `npm run bot -- channel add|rm|ls <bot> <kind>` in `scripts/computer.mjs` to mint and rotate a channel secret without printing the old one.
- [ ] `apps/eve/lib/channels/whatsapp.ts` ported from `vcmc-agent/agent/channels/whatsapp.ts`: same `BridgePayload` (name it bridge protocol v1 and pin it in a shared type), `<whatsapp_context>` block, `<untrusted_context>` fencing, two-image cap, `EMPTY_REPLY_FALLBACK`, sync reply in the response. Auth accepts the hub secret header (ingress path) or `x-bridge-secret` (direct path, so the Vercel fallback and the eve TUI still work). `turnPolicy: "queue"` for groups.
- [ ] `apps/eve/lib/format-reply.ts` ported (`cleanReply`, `outboundReply`, `sanitizeOutbound`) with its tests. Single `*` bold, no headings, tables, fences or em dashes, secrets and credential query params stripped.
- [ ] `apps/eve/lib/tools/expert_invite.ts` placeholder that returns `available: false` with the sign-in fallback line until Phase 2 lands the hub RPC. The channel copy in `bots/main/agent/instructions.md` learns the "a hello.expert link is only for the mouse or a plugin" rule from `vcmc-agent`'s context block.
- [ ] `apps/whatsapp-bridge`: the Baileys bridge moved in as a workspace with its own lockfile and `node --test` suite, tenant-agnostic. `EVE_URL` becomes `COMPUTER_INGRESS_URL` + `CHANNEL_SECRET`; `members.ts` becomes an optional `MEMBERS_OVERLAY_FILE` JSON on the bridge volume; `MAINTAINER_JID`, `OWNER_JIDS`, `DIGEST_RECIPIENT_JID`, `TRIGGER_MODE`, `IMAGE_SENDS_PER_DAY`, `VISION_ENABLED` and transcription stay env. `handleSend` keeps refusing group JIDs. Railway `railway.json` and a `deploy-bridge.yml` workflow come with it.
- [ ] Bridge timeouts cover Machine wake plus a turn: raise the agent-client timeout and keep the existing backoff; log the wake latency so the async path in Phase 3 has a number to beat.
- [ ] `bots/main` gets the channel enabled by file presence (`agent/channels/whatsapp.ts` re-export) and the `computer-use` skill absorbs `vcmc-agent`'s wording on `available:false`, `SEAT_HELD`, and takeover links.
- [ ] Tests: vitest for the channel (payload validation, fencing, fallback, auth paths), the hub ingress (secret, lockout, forwarding, no seat token), and the bridge suite as moved. An `evals/` directory in `apps/eve/bots/main` with three `eve eval` cases: plain-text formatting, quoted-payload fencing (`context-injection`), and never-a-token-in-reply (`no-secrets`), run non-blocking in CI as `vcmc-agent` does.
- [ ] Docs: `apps/eve/README.md` "Enable WhatsApp on a Bot", `AGENTS.md` gotchas for the ingress and the never-post-to-group rule, `api/DESIGN.md` Channels section.

Done when: a message @mentioning the test number in a test group reaches `bots/main` on a suspended `blode`-shaped dev Machine through `/channels/whatsapp/message`, wakes it, and the reply lands in the group in plain text; a DM from a non-member is logged and not answered; `npm run check` green.

### Phase 2: link out, take the mouse, add a plugin

Members never sign in. The chat mints a link; the link opens a mobile-friendly page that does one thing.

- [ ] Invite RPCs: `Agent.CreateInvite { kind: "desk" | "plugin", ttl_sec? }` (bot token; bound to the caller's own display; TTL ≤ 15 min; rate-limited per Bot; written to the thread as an occurrence so the owner sees every link the Bot handed out) and `Seat.CreateInvite` (owner, any display). `Seat.RedeemInvite { code }` (public policy, `Pair`-style lockout, single use) returns a guest seat token scoped to `{ display, methods: Status, SetPresence, Pointer, Type, ClipboardSet, ProvideSecret, expires_at }`. No `ClipboardGet`, no `CreateBot`, no `Occurrences`. `apps/hub/src/service/invite.ts`, handler, `api/DESIGN.md`, `spec.json`, proto.
- [ ] `apps/eve/lib/tools/expert_invite.ts` calls `Agent.CreateInvite` on the hub and returns `{ url, copy }` or `{ available: false, note }`; the URL is `https://hello.expert/i/<computer>/<code>`. Keep `vcmc-agent`'s `publicInviteUrl` filter (https only, allowlisted host, credential query keys dropped) as a test on the way out.
- [ ] hello.expert `/i/[computer]/[code]`: server redeems against that computer's hub (from `lib/computers.ts`), sets an httpOnly cookie holding the guest token scoped to that path, wakes the Machine through `apps/hub/src/host/fly-machine.ts` if suspended, then renders the desk (kind `desk`) or the plugin consent page (kind `plugin`). Expired or used code is a plain page with "ask Vibey for a new link".
- [ ] Mobile desk page (AUDIT P2 #19): full-bleed view-only noVNC with the seat state banner, a trackpad surface driving `Seat.Pointer` (relative move, tap click, long-press right click, two-finger scroll), the keyboard bar driving `Seat.Type` with a paste field and Enter, Esc, Tab, and an "I'm done" button that is `SetPresence(false)`. `dvh` units and a keyboard-aware layout. The iOS app is the reference (`docs/reference/`). PostHog events for take, type, done.
- [ ] Plugin consent page: lists the tenant's `plugins.json`, "Add a plugin" from a small catalogue (remote MCP servers to start; Vercel Connect connectors since `@vercel/connect` is already a `vcmc-agent` dependency), runs OAuth with the client secret on the web server, then `Seat.PutPluginCredential { plugin_id, credential }` stores it hub-side under `/workspace/.computer/plugins/` (0600, hub UID, Phase 0) and appends the descriptor to `plugins.json`. Per-account credentials shared across Bots on the computer, as the iOS sheet shows.
- [ ] `Agent.Connections` (bot token) returns that Bot's plugin descriptors with a short-lived access token each. `apps/eve/lib/dynamic/connections.ts` is a `defineDynamic` connections resolver that turns them into `defineMcpClientConnection` entries (`instanceKey` per plugin, `approval: once()`), replacing the single `COMPUTER_MCP_URL` in `lib/connections/local.ts`. Tokens never enter a tool result.
- [ ] Owner path: the same desk and plugins pages under the signed-in shell, so Matt manages Vibey's computer with an owner seat and members use guest seats.
- [ ] Copy: the WhatsApp reply for a desk link is one line plus the URL, no plumbing words; secret entry is "tap the link, paste the code there", never in chat. The `computer-use` skill and the channel context block say so.

Done when: from a test group, "@bot open the desk" yields a link; opening it on a phone shows the screen, a tap moves the pointer, typed text lands in Chromium, "I'm done" hands the seat back and the Bot's next `computer` call runs; the link is dead on a second open and after 15 minutes; "@bot add a plugin" leads to an OAuth consent that appears as a `connection_search` result on the Bot's next turn; a `ClipboardGet` with the guest token is `UNAUTHENTICATED`.

### Phase 3: the Bot updates itself, and the owner page edits the same files

Instructions, skills, routines and plugins as data; a supervisor for code; the Grok voice inside WhatsApp.

- [ ] Config layout under `/workspace/.bots/<id>/config/` (Section 3) with zod schemas in `packages/shared` (`BotConfig`, `Routine`, `PluginDescriptor`). Seed from the Bot's authored `agent/instructions.md` and `agent/skills/` on first boot so an existing Bot loses nothing.
- [ ] `apps/eve/lib/dynamic/instructions.ts`: `defineDynamic` instructions at `session.started` reading `config/instructions.md`, appending the memory block (from `vcmc-agent`'s `instructions.ts`) and the channel context. Falls back to the last good copy on a parse or size failure and logs it.
- [ ] `apps/eve/lib/dynamic/skills.ts`: `defineDynamic` skills returning a `defineSkill` map from `config/skills/*.md` (description from frontmatter or first line). Verify dynamic skills load under the just-bash sandbox on the guest; if they need a real sandbox, fall back to authored skills plus a supervisor rebuild and say so in the doc.
- [ ] `apps/eve/lib/dynamic/model.ts`: model resolver from `profile.json.model`, so "switch to sonnet" is a config change with a log line, not a deploy.
- [ ] Routines: `apps/eve/lib/schedules/routines.ts`, one `defineSchedule({ cron: "* * * * *" })` dispatcher that reads `routines.json`, resolves each entry's timezone with `Intl` (the `dueSubscribers` trick from the digest), leases due runs through a file-backed schedule store (`claimDue`, `complete`, `release`, at-least-once), runs the prompt in its own session, delivers with `to(whatsapp, { jid })` or `to(eve, …)`, and writes `routines/<id>/runs.jsonl` (last 20). `enabled`, `paused_after_failures`, `last_run` fields. "Test run" is a `Seat.RunRoutine { id }` that enqueues one run now.
- [ ] `bot_config` tool (`apps/eve/lib/tools/bot_config.ts`): `get` and `set` on `instructions`, `skill`, `routine`, `plugin`, `profile`. Validates, runs `looksLikeDirective` on skill and instruction text (port `injection-screen.ts` from `vcmc-agent`), enforces size caps, writes atomically, appends `changes.jsonl`, reads back before answering. `revert` by change id. `write_file` remains available and the resolvers validate on read.
- [ ] Supervisor deploy path for code: `Seat.DeployBot { id, ref? }` and `npm run bot -- deploy <id>`: `git fetch` + checkout in `/workspace/eve/bots/<id>`, `npm ci`, `eve build` into a staging copy, health-probe a candidate process on a spare port, swap, restart, roll back on failure, record the sha and result in `changes.jsonl`. The model reaches this only through `shell` under the Phase 0 `ask` rule, so an owner approves a self-rebuild from the thread.
- [ ] Seat RPCs for the owner page: `Seat.GetBotConfig`, `Seat.PutBotConfig` (same validation and log), `Seat.ListRoutineRuns`, `Seat.RunRoutine`, `Seat.RemovePlugin`. hello.expert Bot page: profile (name, title, mark), instructions editor, skills list with add and edit, routines table (cron in the owner's timezone, enabled, last runs, test run), plugins list, deploy button with the last sha, and the change log with revert. Mobile-first, since Matt will do this from a phone.
- [ ] The Grok voice inside WhatsApp: the bridge issues a per-inbound reply capability (`{ jid, message_id, expires_at }`, signed with the channel secret) that rides the payload; `POST /send` accepts it for that JID only, groups included, so a `send_message` text during a WhatsApp turn ("on it, checking") posts as a reply without touching `OWNER_JIDS`. A `widget` renders as numbered options and parks the session; the next message from that chat resumes it. A `secret_request` mints a desk invite and says "paste it there", never in chat. Reply delivery moves from the synchronous webhook response to `events["message.completed"]` plus the capability, which also removes the bridge timeout coupling from Phase 1.
- [ ] Sessions: with async delivery the per-message random continuation token from `vcmc-agent` is no longer forced. Decide per chat: `whatsapp#<jid>` with `turnPolicy: "queue"` and Eve compaction (in-thread memory, the 30-day `sessionTimeoutMs`) versus fresh per message (grounding via tools). Ship the per-chat token behind a channel option and measure token cost on the test group before making it the default.
- [ ] Evals: routing cases for "change your instructions", "add a routine every morning", "remove that skill" must call `bot_config` and never mint a link; a counter-case where "open the desk" must not touch config. Safety case: a skill body containing `</group_memory>` or an imperative to the model is refused by the screen.

Done when: "@bot from now on answer in one line" edits `config/instructions.md`, the next turn reflects it, the change log shows it, and revert restores it; "every weekday at 8am DM me what I missed" creates a routine that fires at 22:00 UTC and lands as a DM with a run row; the owner page shows the same routine and can test-run it; pushing a new tool to the tenant repo and pressing Deploy rebuilds and restarts with the old build kept; a failed build leaves the old process serving.

### Phase 4: Vibey on the Expert runtime

Cut `vcmc-agent` over. The repo stays; its generic code goes; its content stays.

- [ ] Land the eve 0.49.x upgrade from the Phase 0 spike in `vcmc-agent`.
- [ ] `vcmc-agent` depends on `@computer/eve` and re-exports: `agent/channels/whatsapp.ts`, `agent/tools/{computer,shell,read_file,write_file,expert-invite}.ts`, `agent/lib/hub.ts`, `agent/lib/format-reply.ts` become one-line re-exports or are deleted. `tests/agent/tool-list.test.ts` and `how-im-built.md` keep reconciling the tool list.
- [ ] Content moves to config files on `vcmc-computer`: `base-instructions.ts` → `config/instructions.md`; the four skills → `config/skills/`; `DIGEST_SUBSCRIBERS` → `routines.json` entries with the two digest styles as prompts and the transcript assembly kept as a tenant tool the routine prompt calls; `.mcp.json`'s chrome-devtools entry → `plugins.json` if still wanted (it is a stdio server, so probably not: the desk is the browser).
- [ ] `memory-consolidation` stays a tenant TypeScript schedule until Phase 5; confirm it runs under the supervisor and still reads `revertedIds` from the audit trail.
- [ ] Deployment: delete `vcmc-agent/deploy/fly` and `vcmc-agent/fly.toml` (the Eve-only image conflicts with the Expert guest on the same app); `vcmc-computer` runs `fly.vcmc.toml` from `expert`; the tenant project is a git checkout at `/workspace/eve/bots/main` deployed by `Seat.DeployBot`. Tenant secrets (`BRIDGE_URL`, `WHATSAPP_BRIDGE_SECRET`, `FIRECRAWL_API_KEY`, `BLOB_READ_WRITE_TOKEN`, `AI_GATEWAY_API_KEY`) become Fly secrets on `vcmc-computer`, passed to the Eve child by the supervisor, never on argv.
- [ ] Bridge cutover: the Railway bridge gets `COMPUTER_INGRESS_URL=https://vcmc-computer.fly.dev` and the channel secret; first pointed at a test group, then the VCMC group; the old `EVE_URL` path stays configured until the new one has answered for a week. The bridge code itself comes from `apps/whatsapp-bridge` in `expert`; `vcmc-agent/bridge/` is deleted once Railway builds from `expert`.
- [ ] Evals: the full `vcmc-agent` suite (`npm run test:evals`) against the new runtime; `evals/routing/skills.eval.ts` must still route to the dynamic skills; `elon-image-prompt-injection` and `no-secrets` unchanged.
- [ ] Docs: `vcmc-agent/CLAUDE.md` topology section rewritten (three pieces become two: tenant content in this repo, runtime and bridge in `expert`), `deploy/README.md` replaced by a pointer, `docs/build-your-own-whatsapp-agent.md` updated to "enable the channel on an Expert Bot".

Done when: Vibey answers in the VCMC group and DMs from the Expert runtime with the same evals green; the `vcmc-agent` Vercel project has had zero inbound for a week; the desk link and plugin link work for a member; Matt edits Vibey's instructions from the hello.expert Bot page and Vibey confirms the change in chat.

### Phase 5: data lives on the computer

- [ ] `MemoryStore` interface in `@computer/eve` with the Blob backend (today's `memory-store.ts`, ETag semantics) and a volume backend under `/workspace/.bots/<id>/memory/<safeJid>/` with an advisory lock instead of `ifMatch`. The screens (`screenProposal`, `looksLikeDirective`, `MEMORY_CATEGORY_BUDGET_CHARS`, `neutraliseFence`, provenance quotes) move with the interface, and `memory-internal.test.ts` runs against both backends. Migration script copies Blob → volume, then `MEMORY_BACKEND=volume`.
- [ ] Episodes and the audit log follow the same path; `memory-log` and `revert-memory` unchanged from the model's view.
- [ ] Consider Eve's own `defineMemory` with a custom `MemoryDocumentBackend` on the volume for the generic Bot (`bots/main` has none today beyond `memory.md`); keep Vibey's category store, which is richer than one document per scope.
- [ ] Retire the `vcmc-agent` Vercel project. The AI Gateway key stays a Fly secret (or a direct provider key in `agent.ts`), `BLOB_READ_WRITE_TOKEN` is removed from the box.
- [ ] Bridge placement decision: move `apps/whatsapp-bridge` onto the guest as a supervised process (then `min_machines_running = 1` in `fly.vcmc.toml`, no suspend, Railway gone, one fewer secret pair) or keep Railway (suspend keeps compute at zero). Measure the two monthly bills and the ban risk of a Baileys socket on a Fly IP before deciding.
- [ ] Volume backup runbook (AUDIT P2 #17): nightly `fly volumes snapshot` and a restore test, since after this phase the volume holds the roster, the transcript, memory and the Bot's config.

Done when: `BLOB_READ_WRITE_TOKEN` is unset on `vcmc-computer` and every memory eval passes; a restored volume snapshot boots a working Vibey.

### Phase 6: Grok Bot polish and more than one Bot

From `GROK-BOT.md` Phases 2, 3, 5 and 7, now that the pieces exist.

- [ ] Bots sidebar on hello.expert from `GET /roster` and `profile.json`; "New bot" scaffolds a Bot from a template with the WhatsApp channel off by default; per-Bot chat and screen; unread and `WAITING` badges.
- [ ] One approval model: hub policy `ask` and Eve approvals rendered as the same card with Allow once, Always allow (persisted as a policy rule per Bot), Deny; in WhatsApp an `ask` becomes a widget to the owner's DM.
- [ ] Event triggers as channels: a generic `webhook` channel (`/channels/<id>/…` already exists) that wakes a Bot with `[inbound]`; Slack via Eve's native channel through the same ingress.
- [ ] Multi-Bot on a tenant: a second Bot on `:2` with its own WhatsApp number, sharing plugins and `/workspace`; the Receptionist pattern from the iOS reference.
- [ ] Teach a task: record a takeover session's `Seat.Pointer`/`Seat.Type` stream plus screenshots into a draft skill in `config/skills/`.
- [ ] Voice unification (AUDIT P1 #4): the web thread renders `Seat.Occurrences` and answers widgets and secret requests, so hello.expert and WhatsApp see the same voice.

## 6. Decisions for Matt

Each of these changes the shape of a phase; the plan assumes the first option.

1. **Package versus extension** for sharing the generic layer (Section 3): a published `@computer/eve` with re-exports (keeps tool names) versus an eve extension (prefixed names, no `agent.ts`). Assumed: package.
2. **Bridge placement** after Phase 5: Railway (suspend stays possible) versus on the guest (one machine, always on). Assumed: Railway until measured.
3. **Sessions in WhatsApp** (Phase 3): per-chat continuation with queueing versus fresh per message. Assumed: per-chat behind an option, measured first.
4. **Model per tenant**: Vibey stays on `anthropic/claude-sonnet-5` with adaptive thinking; `bots/main` stays on `openai/gpt-5`. Assumed: per-Bot `profile.json.model`, no global default.
5. **Who may mint a desk invite from chat**: any member who can @mention the Bot (the shared-desk product) versus owner DMs only. Assumed: any member, rate-limited, every link logged in the thread, and Chromium sessions on the shared desk treated as shared.

## 7. Risks

- **Baileys automates a normal WhatsApp account** and the number can be banned. Nothing in this plan changes that; keep the dedicated number, and keep the bridge separable so a Cloud API channel could replace it for a tenant that qualifies.
- **The shared desk is a shared trust domain.** A member with a guest seat sees whatever is signed in on that screen. Phase 2 scopes the seat to one display and 15 minutes and logs every link; it cannot make the desk private. Say so in the `computer-use` skill and on the invite page.
- **Dynamic skills under just-bash** is unverified (Phase 3). The fallback is authored skills plus a supervised rebuild, which still edits the same files but adds a restart.
- **Any member can write the Bot's instructions through `bot_config`** once Phase 3 lands, the same trade `vcmc-agent` already made for memory. The screen, the caps, the fence and the change log are the boundary; the owner page and `revert` are the undo. Do not relax one to make an edit land.
- **eve 0.30 → 0.49 in `vcmc-agent`** may cost more than the spike suggests. Phase 0 sizes it before Phase 4 depends on it.
- **The Fly suspend path** adds seconds to the first reply after idle. Phase 1 measures it; Phase 3's async delivery makes it a typing indicator rather than a timeout.

## 8. Verification, throughout

- `npm run check` in `expert` and `npm test && npm run typecheck` in `vcmc-agent` on every commit; the bridge suite with `node --test`.
- `eve eval` suites non-blocking in CI until stable, then gating, following `vcmc-agent`'s `.github/workflows/ci.yml` note on why.
- Every phase's "done when" is run against a throwaway number and a test group before the VCMC group sees it.
- `api/DESIGN.md`, `api/spec.json` and `packages/shared` change together for every new RPC; `npm run proto:check` gates it.
- Secrets: a grep in CI for `x-bridge-secret`, `COMPUTER_BOT_TOKEN`, `seat` and `token` in any string that reaches `outboundReply`, plus the `no-secrets` eval.
