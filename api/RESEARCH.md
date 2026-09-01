# Research behind computer.v1

What we measured, what we copied, what we refused.
The protocol is [DESIGN.md](DESIGN.md). This file is the argument.

## Where the contract comes from

Two sources, ranked, plus one we refuse.

**Primary — first-party and Apache-2.0.**
[`xai-org/grok-build`](https://github.com/xai-org/grok-build) publishes the
computer-hub wire protocol under `crates/common/`: `xai-tool-protocol`,
`xai-computer-hub-core`, `xai-computer-hub-sdk`,
`xai-computer-hub-mcp-adapter`, `xai-message-delivery-core`. Same vendor,
same licence as this repo, so it can be read and borrowed from rather than
only described. It is a **different layer** from the desktop app — JSON-RPC
2.0 tool routing between harness, hub and tool server, not the in-VM exec
plane — but `xai-tool-protocol::bot_relay` is squarely our layer, and its
`bot.*` verbs are the closest licensed statement of what a Bot is:

- `bot.command`, `bot.vncDescriptor`, `bot.roster`, `bot.status`,
  `bot.transcript.offbox`, `bot.subscribe` / `bot.unsubscribe`,
  `bot.bindConversation`, and a hub→client `bot.event`.
- `agentId` is the routing key everywhere; `name` is metadata beside it.
  Matches our **agent token → Bot → screen**; the model still never names
  a display.
- `bot.roster` and `bot.status` are documented **cold — never wakes the
  box**. We have no hibernation, but the rule that a status read has no
  side effects is worth keeping.

**Secondary — a description, unlicensed.**
[b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed)
is a readable reconstruction of the 0.18 macOS app. It is the best account
of the desktop and exec planes and everything below still stands on it —
but it ships **no LICENSE file**, so it is a source we read and paraphrase,
never one we copy. The behaviour half of the contract (the voice, the wake
table, the gates) comes from
[yuanyijie/learn-grok-bot](https://github.com/yuanyijie/learn-grok-bot),
which is analysis rather than source and says so, and from
[adam91holt/grokbot-sdk](https://github.com/adam91holt/grokbot-sdk) (MIT)
for card types and on-disk layout.

## Sources we refuse

- **`ChHsiching/grok-bot-0.18-original`** — a verbatim proprietary runtime
  archive, mechanically split into a per-module tree. Do not read, clone,
  or cite it. The clean-room claim and the Apache-2.0 licence both rest on
  this contract having been derived from descriptions; ingesting a copy of
  the shipped runtime would retroactively taint work already done.
- **Any repo without a licence, as a source of code.** b-nnett,
  `irons163/filicon-bot` and `gprot42/grok-bot-tool` are all useful and all
  unlicensed. Read for shape, write our own.

## The product we are cloning

Grok Bot (xAI branding; the client and cloud substrate are built by
Anysphere/Cursor — bundle id `com.anysphere.sand`, DMG from
`downloads.cursor.com`, codename "sand") is one **persistent Linux
environment per account**: an **anyrun pod — a Firecracker microVM
booting a Docker-built image** — with full memory+disk snapshot
hibernation to blob storage and wake-on-connect (`resume_*` params on
the viewer URL). Not always-hot; persistence is hibernation. Bots
share the machine and get a **screen**, not a box. Clients: macOS,
Windows, iOS 18+. The laptop can close. iOS is a real takeover:
trackpad, pinch, clipboard, **I'm done**. Cost is plan + tokens, not
VM-hours.

The 0.18 reconstruction (secondary source, above) describes the desktop
and exec planes:

- Pixels = **VNC**, not WebRTC: x11vnc → websockify → noVNC behind a
  token-authenticated proxy (`x-anyrun-network-token`), port 6080
  primary, 6081+ forks. Electron loads a trusted webview at `vncUrl`.
- Clipboard and `reportUserPresence` are **IPC beside VNC**, not RFB.
- Computer-use space **1280-wide scaled** (advertised 1280×800; a
  `CoordinateScaler` maps API↔real pixels via xrandr). Actions run
  in-VM over a Connect-RPC exec daemon, not over the VNC channel.
- Exec is ConnectRPC on loopback, separate from pixels.
- Shared box id `"shared"`; Bots get **window indexes = X displays**
  (`:1` primary, forks `:2+`, max 100), persisted in
  `/home/box/.sand-window-assignments.json` with per-agent owner
  tokens; a fork router routes by display/owner headers. Bots are
  explicitly **not security boundaries** (one `box` user, shared
  `/workspace`).
- Hand-off: `request_box_help` shows an instruction over the box and
  in chat; the human drives the streamed desktop; hand-back carries a
  completed/cancelled resolution. That is the seat.

We ship the same shape at max 8 windows, the hub playing the router
role (token → Bot → display instead of headers).

No iOS source in that repo. The phone chrome is the product we write.

## The behaviour contract

Everything above is transport. This is the half that says what the agent is
*obliged* to do, and until now it was missing from this file. Source:
`learn-grok-bot` PRODUCT.md / ARCHITECTURE.md, corroborated by `grokbot-sdk`.

**The voice.** Plain model text is an inner monologue. The user sees only
what the agent explicitly sends. Bubbles are `SendMessage` occurrences, not
assistant prose. Delete that gate and the scratchpad leaks into the chat —
a different product. Card types and their turn behaviour:

| Type | User sees | Ends the turn? |
|---|---|---|
| text | bubble, optional images | no — long work is several short bubbles |
| widget | 1–6 real options | **yes. stop and wait** |
| secret-request | masked input; value skips the transcript | **yes** |
| attachment | file or standalone media | no |

`MAX_CHOICE_OPTIONS = 6`; styles `default | primary | danger`. Rules that
have to be enforced, not merely prompted: **reply first** on any
person-opened turn, **ack is not delivery**, deciding to send is not
sending, and no plumbing words to the user — say "my computer", never
"box".

**Wakes.** Same runner, different door. Who woke the agent changes whether
silence is legal:

| Wake | Cue | Person waiting? | May stay silent? |
|---|---|---|---|
| user text | — | yes | no |
| just created | `[first run]` | yes | no |
| channel inbound | `[inbound]` | on that channel | no |
| schedule / file | `[routine]` | no | **yes** |
| teammate | `SendToAgent` | depends | depends |
| background finished | revival | usually no | yes |

The silent routine is the rule that stops cron spam. It is a property of
the wake, not of the model's mood.

**Gates.** Default is act; asking is earned — irreversible, unresolvable
ambiguity, or only the human knows. Question widget, secret-request,
auto-review (`off` / `shadow` / `enforce`), and hand-back-the-desktop. After
a block: adapt to a genuinely safer path, or escalate with the **same
action unchanged** so a human card appears. Never route around with
cookies or a stolen token.

**Work-surface ladder.** memory and box files → connector → public web →
signed-in box browser → box desktop GUI → hand back to the human. A broken
connector is news, not something to silently replay in the browser.

**Delivery operations.** `xai-message-delivery-core` models an inbound
message as `Principal` (`Human | Agent | Runtime`) plus an `Operation` —
`Queue`, `Steer`, `Interject`, `InterruptAndSend`. Our `POST /chat` has one
behaviour instead: a per-Bot mutex returning `409 CONFLICT "bot is busy"`.
`Queue` alone would be strictly better; the phone should not get an error
because the agent is mid-turn.

## The persistence contract

The single most-asked question in the Cursor forum threads (indexed by
[awesome-grok-bot](https://github.com/RongleCat/awesome-grok-bot)) is what a
"computer update" costs you. Staff answers there settle it, and the answer is
narrower than users expect:

| Path | Survives a computer update? |
|---|---|
| `/workspace` | yes |
| browser profile | yes |
| `~/.config` | yes |
| `~/.local/state` | **no** |
| `apt install`ed packages | **no** — the OS image is rebuilt |
| background processes | no — the box sleeps when idle |

`~/.local/state` is the one that draws the threads: it is where WhatsApp Web
and Signal keep a linked device, so users re-scan the QR after every update
and read it as a bug. It is not — it is the boundary.

The staff remedy for packages is a **list in a file** that the agent
reinstalls after an update, not a persisted package store. We copy the
boundary exactly, including its sharp edges. The point is that a skill
written for a Bot runs here unmodified; a wider boundary is as wrong as a
narrower one, because a skill written against ours would then break on
theirs.

**"Nix package persistence" stays on `plan.md`'s cut list.** apt packages
dying on an image rebuild is not a defect we inherited by accident — it is
the behaviour Grok has. Baking a Nix store to keep them would make this box
*more* durable than the thing we are cloning, which breaks the contract in
the direction nobody notices until a skill relies on it. The fix is
documentation (README's "What survives"), not a volume.

Two volumes carry this: `workspace:/workspace` and `config:/home/box/.config`.
`~/.config` is one volume rather than a parent plus a nested
`config/chromium` one — Docker mounts parent before child and both do
persist, verified, but the nested form leaves a permanently empty
`chromium/` in the parent, so anyone inspecting or backing up the parent
volume silently misses the profile. One volume also covers windows 2–8,
whose profiles live at `~/.config/chromium-N` and were previously on the
container layer, i.e. lost on every rebuild.

Our window claims sit in `/workspace/.window-assignments.json`, not beside
the 0.18 app's `/home/box/.sand-window-assignments.json` in `$HOME`:
`$HOME` is not on a volume here, and a rebuild must not cost a Bot its
screen.

## What the first-party protocol does that we don't

Read off `xai-tool-protocol`. Each is a deliberate difference, not an
oversight, and each has a cost.

- **VNC descriptors expire.** `bot.vncDescriptor` returns
  `{ vncUrl, expiresHint }` — a port-token expiry the client refreshes
  before, with `null` reserved for the legacy never-expiring form. Ours
  mints one permanent seat token, stamps it into the URL query string, and
  never rotates it. A leaked `vnc_url` is leaked for the life of the box.
- **Status enums degrade, they do not throw.** `BotRunState`
  (`absent | hibernated | running | unknown`) has a hand-written
  `Deserialize` whose whole job is that an unknown wire string becomes
  `Unknown` rather than an error, "so the typed parse never fails across
  independently-deployed hub/SDK versions". `WorkspaceGoneReason` and
  `WorkspaceGonePhase` use `#[serde(other)]` for the same reason.
  `apps/ios/Computer/Models/ComputerV1.swift` decodes `SeatState` and
  `ErrorCode` as plain Swift `String` enums, which **throw** on an unknown
  value — so adding a state server-side breaks every phone already
  installed. Strictness is right for model → hub, where a typo should be a
  loud `VALIDATION`; it is wrong for hub → phone.
- **There is a taxonomy for "can't reach your computer".**
  `workspace_unavailable` carries `{ reason, phase, retryable }` —
  `reason` one of idle-timeout / disconnect / shutdown / not-bound /
  instance-gone / hibernated, `phase` one of in-flight-cancelled /
  route-missing / attach. We have one `DAEMON_DOWN` and an iOS client that
  swallows it. `retryable` is the field the UI actually needs.
- **Transcripts page.** `bot.transcript.offbox` takes an opaque `cursor`
  and returns `nextCursor`. Worth building the occurrence log that way from
  the start rather than streaming it whole.
- **Rejections are a closed, counted set.** `COMMAND_REJECTED_REASONS` is a
  sorted const, codegen fails if it drifts from the individual constants,
  and the hub checks its metrics labels against it "so a new reason cannot
  land uncounted". Good discipline for our `ErrorCode`.

## Three ChatGPT machines (do not collapse them)

1. **Cloud Operator** — virtual browser + terminal. Phone watches and
   can take over a login. No local apps, no `/workspace`.
2. **Computer Use plugin** — drives *your* Mac/Windows. Lid closed =
   dead (except macOS locked-use). Opposite of Grok.
3. **@Chrome / @Browser** — a browser, not a desktop.

Model API: screenshot in, `actions[]` out. Shell is a separate tool.
We take the action-list idea. We do not take "drive the user's laptop."

## Adjacent products we are not

| Product | What it is | Why not the target |
|---|---|---|
| Superlogical | Durable **terminal** + iOS later | No desktop computer-use |
| Poke | iMessage/WhatsApp assistant | Computer use = tunnel to *your* awake machine |
| Town | Townie + wiki; Mac app uses Accessibility | Same sleep problem |
| OpenClaw | Always-on gateway + Tailscale + iOS **node** | Camera/location, not a Codex/Grok desktop |
| Hermes + cua-driver | Best OSS **driver** | Telegram; needs Xvfb/XFCE; GTK vs TigerVNC `XSendEvent` hole → **uinput** |
| Case / GhostDesk / Figaro | Closest OSS desktops | Wrap ≠ own the seat/API |
| OpenMausBot / SuperAgents | Tiny Grok-product clones | 1-star surfaces, not a protocol |

Vercel / Cloudflare Workers / Railway cannot host a desktop.
Cheap analogue: Hetzner + Tailscale (post June-2026 prices: CX33
4 vCPU/8 GB €8.49/mo, CX43 €15.99/mo) — always-hot, documented as
an alternate in deploy/cloud-init.yaml. Per-second sandboxes (E2B,
Daytona, Modal, Morph) are ~10× for an always-on pet machine; Fly.io
suspend/resume is the only cheap off-the-shelf imitation of Grok's
hibernation, and that path is checked in as fly.toml (one Machine,
desk+hub guest, volumes for /workspace and ~/.config).

## Hosted computer-use APIs

### OpenAI CUA

Batched `actions[]`: `click`, `type`, `scroll`, `keypress`, `drag`,
`move`, `wait`, `screenshot`. Pixel coords. Display declared.
`pending_safety_checks` before continuing a risky step.

**Take:** one union, not one tool per verb. `request_id` + pending
checks. Names a model already emits.

**Leave:** no seat. No phone takeover. Safety acknowledge is a model
RPC; ours is the human on the seat.

### Claude `computer_toolset_20260801`

17 members, batch sequential. **Zoom** (region at full res; coords
stay in the full screenshot). If one action fails, still return
results for the rest as skipped.

**Take:** skip-the-rest. Zoom without rematching. Per-action results
with duration.

**Leave:** 17 named tools. We have 11 members of one union. No
browser-specific verbs (`navigate`, `form_input`) — Chromium is an app.

### Gemini

Normalized **0–999** coords. `safety_decision`. Browser verbs.

**Refuse the 0–999 space.** It looks portable and breaks the moment
zoom or a second display exists. Adapters **divide then multiply**
into 1280×800. We never emit 0–999.

### Fat MCP (64 tools)

The anti-pattern. `left_click`, `right_click`, `middle_click` as
separate tools explode the prompt and fight models trained on a
single `computer` tool. One union. Four tools on the agent.

## Seat is the piece they all lack

OpenAI, Claude, and Gemini assume the model holds the display until
the task ends. Grok's iPhone exists because the interesting tasks
**stop** at a password, a 2FA prompt, a captcha, a payment.

```
AGENT ──request_takeover──► WAITING ──I'm done──► AGENT
                              │
                              └── pointer/clipboard ──► HUMAN ──I'm done──► AGENT
```

`SEAT_HELD` is a first-class error, not a retry loop. Clipboard is
on the seat, not the model (injection). Pointer on the phone is
**deltas**, not screenshot coordinates — the human is looking at
the stream. The iOS keyboard is `Seat.Type`, also not a model tool.

## Coordinate invariant (the one that matters)

Every `x`,`y` is a pixel of the **last full-display screenshot**.
Origin top-left. 1280×800. Scale 1.

Claude 2026: zoom returns a crop; the next click is still in the
full space. Copy that sentence and stop. Gemini 0–999 is the
other sentence. Do not write it.

## What ships vs what waits

| In v1 | Later |
|---|---|
| One box, many Bots, one screen per Bot (max 8) | Bot roster UI, Firecracker snapshot/hibernation |
| VNC view-only + native chrome | WebRTC |
| XTEST (`xdotool`) | Anything using `XSendEvent`; uinput, which no virtual X server reads |
| UTF-8 clipboard | Images |
| `pending_checks` + takeover | Model-side acknowledge RPC |
| Hetzner + Tailscale Serve | Public bind, Nix bake |

## Sources

- OpenAI computer use: https://developers.openai.com/api/docs/guides/tools-computer-use
- Anthropic computer use (GA toolset, zoom, batch skip)
- Gemini Computer Use (normalized coords — negative example)
- Computer-hub wire protocol (first-party, Apache-2.0):
  https://github.com/xai-org/grok-build — `crates/common/xai-tool-protocol`,
  `xai-computer-hub-core`, `xai-message-delivery-core`
- 0.18 reconstruction (secondary, no licence):
  https://github.com/b-nnett/grok-bot-0.18-reconstructed
- Behaviour contract: https://github.com/yuanyijie/learn-grok-bot
  (PRODUCT.md, ARCHITECTURE.md, MECHANISMS.md)
- Host gateway command table and on-disk layout (MIT):
  https://github.com/adam91holt/grokbot-sdk
- `.grok-plugin` format: https://github.com/xai-org/plugin-marketplace
  (`scripts/plugin_catalog.py`)
- Persistence and failure modes: Cursor forum threads, indexed by
  https://github.com/RongleCat/awesome-grok-bot
