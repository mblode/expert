# Research behind computer.v1

What we measured, what we copied, what we refused.
The protocol is [DESIGN.md](DESIGN.md). This file is the argument.

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

Public 0.18 reconstruction
([b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed))
is the desktop spec, not a fork:

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
4 vCPU/8 GB €8.49/mo, CX43 €15.99/mo). Per-second sandboxes (E2B,
Daytona, Modal, Morph) are ~10× for an always-on pet machine; Fly.io
suspend/resume is the only cheap off-the-shelf imitation of Grok's
hibernation.

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
- 0.18 reconstruction: https://github.com/b-nnett/grok-bot-0.18-reconstructed
