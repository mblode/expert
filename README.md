# Computer

A persistent Linux **computer** — one machine per account — that agents drive and a human can take the seat of.

This repository is the **compute substrate**. Clients and product auth come later.

```
local:   docker compose  →  desk container  +  hub on the host
cloud:   Fly Machine     →  desk + hub in one guest microVM
```

Protocol: [api/DESIGN.md](api/DESIGN.md). Clean-room Apache-2.0 implementation of the Grok Bot desktop contract. The primary source is xAI's own Apache-2.0 publication — [`xai-org/grok-build`](https://github.com/xai-org/grok-build) ships the computer-hub wire protocol under `crates/common/` (`xai-tool-protocol`, `xai-computer-hub-core`, `xai-message-delivery-core`). [b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed) describes the 0.18 desktop app and is a secondary source, not a fork — note that it carries no licence grant. See [api/RESEARCH.md](api/RESEARCH.md) for what we take from each and what we refuse to read.

## Grok mapping

Grok Bot's computer (from [api/RESEARCH.md](api/RESEARCH.md) and public xAI docs):

| | Grok | This repo |
|---|---|---|
| Prod guest | anyrun **Firecracker** microVM booting a Docker-built Debian image | **Fly.io Machine** running `apps/desk` + `apps/hub` ([fly.toml](fly.toml)) |
| Hibernation | memory + disk snapshot to blob storage, wake-on-connect | Fly **suspend / resume** (and proxy auto-start). v1 explicit sleep is start/stop |
| Local / dev | Docker container | `docker compose` — unchanged |
| Inside | X 1280×800, x11vnc/noVNC, ConnectRPC hub on loopback | Xvnc 1280×800, noVNC, ConnectRPC hub. One machine; Bots share it and get a screen |
| Not this | Vercel / Workers / Railway | They cannot host a standing desktop. Do not try. |

Hetzner always-on via [deploy/cloud-init.yaml](deploy/cloud-init.yaml) is an **alternate** always-hot option, not the default. There is no custom Firecracker orchestrator in this repo.

Auth, Tauri, iOS login, and a hosted web front door are **explicitly later**. Pairing (`Seat.Pair` + setup code) is what boots the hub today.

## Local (Docker)

```sh
git clone https://github.com/mblode/expert-computer && cd expert-computer
npm install
npm run up
```

`up` generates `.env` (random setup code), builds the desk container, publishes the hub over Tailscale Serve when present, and prints a pairing QR. You need a running Docker daemon (Docker Desktop, OrbStack, colima — anything the `docker` CLI talks to).

Without Tailscale the hub still runs; open `http://127.0.0.1:8787` for the panel, or `http://127.0.0.1:8787/vnc/index.html?token=…` for pixels. The desk is a Debian container running Xvnc at 1280×800 per screen, on amd64 and arm64.

`docker compose up --build` is the same desk. The hub stays on the host (`npm run hub` / `npm run up`) and talks to the container with `docker exec`. That split is the local path only.

Provision Bots on the fly — each gets its own screen on the shared box and a minted token (shown once):

```sh
npm run bot -- new night   # → Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

A paired seat is the box owner (`Seat.CreateBot` / `Seat.DeleteBot`).

## Cloud (Fly Machine)

The guest that must run in a hosted microVM is `apps/desk` + `apps/hub`. [fly.toml](fly.toml) + [deploy/fly/Dockerfile](deploy/fly/Dockerfile) bake both into one Machine. Fly's HTTPS proxy is the public door to the hub (`force_https`, internal port 8080). RFB stays on loopback inside the guest; the hub proxies pixels.

```sh
# once per account — change `app` in fly.toml; names are global
fly launch --copy-config --no-deploy
fly volumes create computer_workspace --size 10 --region syd
fly volumes create computer_config --size 2 --region syd
fly volumes create computer_hub --size 1 --region syd
fly secrets set COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
fly deploy
```

One Machine. Do not scale out — volumes do not replicate, and Grok is one computer per account.

### Wake / sleep

The computer is **not** assumed always-on.

| | What happens | What survives |
|---|---|---|
| **suspend** (Grok analogue) | Fly writes a memory snapshot; resume is a warm start | RAM + the three volumes |
| **stop** (`npm run machine -- sleep`) | v1 sleep. Processes die | the three volumes only |
| **start** (`npm run machine -- wake`) | resume from suspend, or cold boot | — |
| Fly proxy | `auto_stop_machines = "suspend"`, `auto_start_machines = true`, `min_machines_running = 0` | wake-on-connect: the next HTTPS request starts the Machine |

```sh
export FLY_API_TOKEN=…          # not in git
export FLY_APP_NAME=computer
npm run machine -- status
npm run machine -- sleep        # stop
npm run machine -- wake         # start
npm run machine -- suspend      # memory snapshot, if the Machine is eligible
```

Suspend requires ≤2 GB RAM and no swap — that is why [fly.toml](fly.toml) is 2 GB. Need more RAM? Raise `memory` and set `auto_stop_machines = "stop"`; v1 sleep is already stop.

A computer update (`fly deploy`) replaces the guest image the same way a desk rebuild does: packages and `~/.local/state` go away; `/workspace` and `~/.config` stay on volumes. `/data` (roster, seats, pairing code) stays too.

## What survives

Two guest paths persist, and that is Grok Bot's own boundary — matched deliberately, so a skill written for a Bot needs no edit here.

| | compose restart / Machine start | rebuild / `fly deploy` | `down -v` / destroy volumes | Machine sleep (stop) | Machine suspend |
|---|:--:|:--:|:--:|:--:|:--:|
| `/workspace` — files, the Bot's own state | yes | yes | no | yes | yes |
| `~/.config` — every Chromium profile, app config | yes | yes | no | yes | yes |
| hub roster (`data/` locally, `/data` on Fly) | yes | yes | no | yes | yes |
| `~/.local/state` — WhatsApp/Signal linked devices | yes | **no** | no | no | yes |
| `~/.ssh`, `~/.gitconfig`, anything else in `~` | yes | **no** | no | no | yes |
| `apt install`ed packages | yes | **no** | no | no | yes |
| running processes, `/tmp`, X displays | no | no | no | no | yes |

The bold cells are the ones that bite. A rebuild replaces the image, so packages go with it — keep the list in `/workspace/packages.txt` and have the agent reinstall after an update, the same drill Grok users are given. A linked-device session under `~/.local/state` has to be re-scanned. Anything else you want to keep, put in `/workspace` and symlink.

Window claims live in `/workspace/.window-assignments.json`, so a rebuild does not cost a Bot its screen — the desk restarts every window it had.

Each Bot's own state is under `/workspace/.bots/<id>/` for the same reason: `profile.json`, `memory/profile.md`, and its thread as `transcript.jsonl`. Grok keeps this in `~/sand-data`, which on this box a rebuild would erase. The Bot's **token is not there** — the roster on the host (`data/bots.json`) or on the Fly `/data` volume is the only place a bearer lives, and the box only ever sees `sha256(token)`. Bots are not security boundaries, so every Bot can read every other Bot's directory. Deleting a Bot frees its screen and its roster row and leaves the directory alone; `rm -rf` it from the desk to be rid of it.

## Always-hot alternate (Hetzner)

Paste [deploy/cloud-init.yaml](deploy/cloud-init.yaml) into a new Ubuntu 24.04 VM, `tailscale up`, `npm run up`. The VM stays billed while it runs. Use this when you want always-on Docker compose in a datacenter, not when you want Grok-like sleep.

## Eve as the harness

[Eve](https://eve.dev) (Vercel's agent framework) is the brain; this box is the body. `apps/eve/` is an Eve agent whose four tools are the computer — `computer` even hands the model screenshots as vision input — plus a persona (`agent/instructions.md`) and a computer-use playbook (`agent/skills/computer-use.md`).

```sh
npm run bot -- new eve      # prints the two lines for apps/eve/.env
cd apps/eve && cp .env.example .env   # paste token, set AI_GATEWAY_API_KEY
npm run eve                 # (from the root) talk to Eve in the dev REPL
```

Eve runs **on the box**, beside the hub, over loopback — nothing public. She keeps her state in `/workspace`, drives her own screen, and when she hits a 2FA prompt she calls `request_takeover`: the client banners, you take the seat, tap I'm done, she continues. Requires Node ≥24 for the Eve runtime (the hub itself runs on ≥20). Deploying Eve to Vercel instead works but needs a path back to the box — deliberately not the default.

## Shape

```
apps/hub/       ConnectRPC, noVNC static, fallback chat loop, provisioning
apps/desk/      Debian + Openbox + Chromium + TigerVNC (Xvnc), XTEST input
apps/eve/       Eve agent (eve.dev): the harness — persona, skills, computer tools
apps/web/       Control panel, served by the hub (`next export`)
apps/ios/       Computer.xcodeproj (SwiftUI) — pairing client; product auth later
packages/proto  buf generate (protoc-gen-es + Swift) from api/computer.proto
packages/shared branded IDs, error codes
deploy/fly/     Guest image + entrypoint for the Fly Machine
fly.toml        Cloud computer host (suspend / HTTPS / volumes)
scripts/        computer.mjs — up / qr / bot new|ls|rm|token
                `npm run machine` — Fly wake / sleep / suspend / status
```

Two services. Four model tools. A seat per screen.

| Service | Audience | RPCs |
|---|---|---|
| `Agent` | model | Spec, Computer, Shell, ReadFile, WriteFile |
| `Seat` | human | Pair, Status, SetPresence, Pointer, Type, ClipboardGet, ClipboardSet, CreateBot, DeleteBot |

Clipboard, `vncUrl`, and pointer are **not** model tools. VNC is view-only — the X server refuses RFB key and pointer events outright, so a viewer cannot touch the box; input arrives only as `Seat.Pointer`/`Seat.Type`, which is what lets the hub enforce the seat.

**Many Bots, one box.** Each Bot owns a screen (window index = X display, `:1`–`:8`, RFB on `5900 + N`); its token is its identity — **agent token → Bot → screen**, the model never names a display. Bots are provisioned at runtime; the roster lives in `data/bots.json` locally (gitignored — it holds tokens) or `/data` on Fly. Bots are **not** security boundaries: one `box` user, shared `/workspace`.

Locally the hub binds `127.0.0.1`. On Fly it binds `0.0.0.0` behind the platform proxy. Do not bind `0.0.0.0` on a machine that is not a Fly guest.

Agent LLM is BYO (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`); without it the hub still pairs, streams the desktop, and serves the four tools.

## Checks

```sh
npm run proto:check    # copy + buf lint + generate + gen/ committed
npm run lint           # layer rules
npm test               # hub tests
```

`api/computer.proto` is the source of truth; `packages/proto/gen` is committed output (TypeScript + Swift).
