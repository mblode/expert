# Computer

A standing Linux **box** your agents drive and your iPhone can take over. Computer as a service, on your own machine.

iPhone (Computer.app) → hub (ConnectRPC on loopback + Tailscale Serve) → desk (Docker, TigerVNC, one 1280×800 screen per Bot).

Protocol: [api/DESIGN.md](api/DESIGN.md). Clean-room Apache-2.0 implementation of the Grok Bot desktop contract. The primary source is xAI's own Apache-2.0 publication — [`xai-org/grok-build`](https://github.com/xai-org/grok-build) ships the computer-hub wire protocol under `crates/common/` (`xai-tool-protocol`, `xai-computer-hub-core`, `xai-message-delivery-core`). [b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed) describes the 0.18 desktop app and is a secondary source, not a fork — note that it carries no licence grant. See [api/RESEARCH.md](api/RESEARCH.md) for what we take from each and what we refuse to read.

## Up in three commands

```sh
git clone https://github.com/mblode/expert-computer && cd expert-computer
npm install
npm run up
```

`up` generates `.env` (random setup code), builds the desk container, publishes the hub over Tailscale Serve, and prints a pairing QR. Scan it from Computer.app. That's the whole setup — there is no config to write.

You need a running Docker daemon (Docker Desktop, OrbStack, colima — anything the `docker` CLI talks to) and, for the phone, [Tailscale](https://tailscale.com/download) on both the box and the phone. Without Tailscale the hub still runs; open `http://127.0.0.1:8787/vnc/index.html?token=…` from a browser on the same machine (`npm run bot -- ls` and the Seat API hand you the URL). The desk is a Debian container running Xvnc at 1280×800 per screen, on amd64 and arm64.

Provision Bots on the fly — each gets its own screen on the shared box and a minted token (shown once):

```sh
npm run bot -- new night   # → Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

The phone can do the same: `Seat.CreateBot` / `Seat.DeleteBot` — a paired seat is the box owner.

## Eve as the harness

[Eve](https://eve.dev) (Vercel's agent framework) is the brain; this box is the body. `apps/eve/` is an Eve agent whose four tools are the computer — `computer` even hands the model screenshots as vision input — plus a persona (`agent/instructions.md`) and a computer-use playbook (`agent/skills/computer-use.md`).

```sh
npm run bot -- new eve      # prints the two lines for apps/eve/.env
cd apps/eve && cp .env.example .env   # paste token, set AI_GATEWAY_API_KEY
npm run eve                 # (from the root) talk to Eve in the dev REPL
```

Eve runs **on the box**, beside the hub, over loopback — nothing public. She keeps her state in `/workspace`, drives her own screen, and when she hits a 2FA prompt she calls `request_takeover`: your phone banners, you take the seat, tap I'm done, she continues. Her first `shell` call each session asks you once (Eve's approval gate); everything else flows. Requires Node ≥24 for the Eve runtime (the hub itself runs on ≥20). Deploying Eve to Vercel instead works but needs Tailscale Funnel to reach the box — deliberately not the default.

Fresh cloud box instead? Paste [deploy/cloud-init.yaml](deploy/cloud-init.yaml) into a new Ubuntu 24.04 VM (a Hetzner CX33 at €8.49/mo is plenty), `tailscale up`, `npm run up`.

## Shape

```
apps/hub/       ConnectRPC, noVNC static, fallback chat loop, provisioning
apps/desk/      Debian + Openbox + Chromium + TigerVNC (Xvnc), XTEST input
apps/eve/       Eve agent (eve.dev): the harness — persona, skills, computer tools
apps/ios/       Computer.xcodeproj (SwiftUI, iOS 18+)
packages/proto  buf generate (protoc-gen-es + Swift) from api/computer.proto
packages/shared branded IDs, error codes
scripts/        computer.mjs — up / qr / bot new|ls|rm|token
```

Two services. Four model tools. A seat per screen.

| Service | Audience | RPCs |
|---|---|---|
| `Agent` | model | Spec, Computer, Shell, ReadFile, WriteFile |
| `Seat` | iPhone / owner | Pair, Status, SetPresence, Pointer, Type, ClipboardGet, ClipboardSet, CreateBot, DeleteBot |

Clipboard, `vncUrl`, and pointer are **not** model tools. VNC is view-only — the X server refuses RFB key and pointer events outright, so a viewer cannot touch the box; input arrives only as `Seat.Pointer`/`Seat.Type`, which is what lets the hub enforce the seat.

**Many Bots, one box.** Each Bot owns a screen (window index = X display, `:1`–`:8`, RFB on `5900 + N`); its token is its identity — **agent token → Bot → screen**, the model never names a display. Bots are provisioned at runtime; the roster lives in `data/bots.json` (gitignored — it holds tokens). Bots are **not** security boundaries: one `box` user, shared `/workspace`.

## Compute

Provider-agnostic: any Linux machine that stays on and runs Docker — a Hetzner/DO VM, a spare mini PC. Vercel/Cloudflare Workers/Railway can't host a standing desktop. The hub binds `127.0.0.1`; Tailscale Serve publishes HTTPS. Do not bind `0.0.0.0`.

Agent LLM is BYO (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`); without it the hub still pairs, streams the desktop, and serves the four tools.

## iPhone

Open `apps/ios/Computer.xcodeproj` on a Mac. TestFlight, not App Store.

```sh
xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

The product proof is cellular, lid shut: pair → chat → Open Computer → take seat → paste → I'm done → lock 30s → reconnect.

## Checks

```sh
npm run proto:check    # copy + buf lint + generate + gen/ committed
npm run lint           # layer rules
npm test               # hub tests
```

`api/computer.proto` is the source of truth; `packages/proto/gen` is committed output (TypeScript + Swift).
