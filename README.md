# Computer

A persistent Linux **computer** — one machine per account — that agents drive and a human can take the seat of.

This repository is the **compute substrate**. Product sign-in lives on the Vercel Next app (`apps/web`); the Fly hub stays pairing-based internally.

```
local:   docker compose  →  same guest (Debian + box + X.Org + x11vnc)
cloud:   Fly Machine in syd  →  Anyrun analogue (not Cursor-private Anyrun)
```

Protocol: [api/DESIGN.md](api/DESIGN.md). Clean-room Apache-2.0 implementation of the Grok Bot desktop contract. The primary source is xAI's own Apache-2.0 publication — [`xai-org/grok-build`](https://github.com/xai-org/grok-build) ships the computer-hub wire protocol under `crates/common/` (`xai-tool-protocol`, `xai-computer-hub-core`, `xai-message-delivery-core`). [b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed) describes the 0.18 desktop app and is a secondary source, not a fork — note that it carries no licence grant. See [api/RESEARCH.md](api/RESEARCH.md) for what we take from each and what we refuse to read.

## Grok mapping

Grok Bot's computer (from [api/RESEARCH.md](api/RESEARCH.md) and public xAI docs):

| | Grok / Anyrun | This repo |
|---|---|---|
| Prod host | Cursor Anyrun: Firecracker on EC2 (private) | **Fly Machines** in **syd** ([fly.toml](fly.toml)) |
| Guest image | Docker-built Debian, user `box` | same: `apps/desk` Debian, non-root `box` |
| Display | X.Org 1280×800, `:1` + forks `:2+` | Xvfb (X.Org) 1280×800, one screen per Bot |
| Pixels | x11vnc → websockify → noVNC; 6080 / 6081+ | **x11vnc** (not TigerVNC), view-only; 6080 primary, 6081+ tokenized forks |
| Exec | ConnectRPC hub on loopback | same; input is Seat + XTEST, never RFB |
| Sleep | memory+disk snapshot, wake-on-connect | Guest suspends after **20 min** idle. Status/roster **do not wake**. VNC/use may. |
| Local | Docker container | `docker compose` — the same guest |
| Not this | Vercel / Workers / Railway / Sprites 30s stop / Anyrun API | Do not host the desktop there. Do not auto-stop after 30s. |

Hetzner always-on via [deploy/cloud-init.yaml](deploy/cloud-init.yaml) is an **alternate** always-hot option, not the default. There is no custom Firecracker orchestrator in this repo.

Product auth is Better Auth on Vercel (`apps/web`). After a valid session the web server Pairs with the hub using `COMPUTER_SETUP_CODE` (never `NEXT_PUBLIC`) and puts the seat token on the session. iOS still uses setup-code pairing. Tauri and Eve-on-Vercel are out of scope.

## Local (Docker)

```sh
git clone https://github.com/mblode/expert-computer && cd expert-computer
npm install
npm run up
```

`up` generates `.env` (random setup code), builds the desk container, publishes the hub over Tailscale Serve when present, and prints a pairing QR. You need a running Docker daemon (Docker Desktop, OrbStack, colima — anything the `docker` CLI talks to).

Without Tailscale the hub still runs; open `http://127.0.0.1:8787` for the panel, or `http://127.0.0.1:8787/vnc/index.html?token=…` for pixels. The desk is a Debian container: X.Org (Xvfb) 1280×800, x11vnc on localhost, noVNC on 6080 / 6081+, amd64 and arm64. That is Grok's local Docker box.

`docker compose up --build` is the same desk. The hub stays on the host (`npm run hub` / `npm run up`) and talks to the container with `docker exec`. That split is the local path only.

Provision Bots on the fly — each gets its own screen on the shared box and a minted token (shown once):

```sh
npm run bot -- new night   # → Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

A paired seat is the box owner (`Seat.CreateBot` / `Seat.DeleteBot`).

## Cloud (Fly Machine in syd)

**Fly Machine in syd = the Anyrun analogue.** Local Docker = Grok's local Docker box. Cursor Anyrun itself is private; we do not call it.

Two process groups in [fly.toml](fly.toml):

| Process | Role | Size (start) |
|---|---|---|
| `edge` | Always-on public HTTPS. Status / `GET /roster` **never start** the guest. | 1 shared CPU / 256 MB |
| `computer` | The guest: X.Org + x11vnc + hub. Suspends after 20 min idle. | **shared-cpu-4x / 4 GB** |

Grok's measured SKU is **8 vCPU / 16 GB / 128 GB disk**. Scale the computer to that:

```sh
fly scale vm shared-cpu-8x --memory 16384 --process-group computer
fly volumes extend computer_workspace --size 128
```

Do **not** auto-stop after 30s (that is Sprites, too aggressive for a desktop). Idle suspend is 20 minutes (`COMPUTER_IDLE_SUSPEND_SEC=1200`).

```sh
# once per account — change `app` in fly.toml; names are global
fly launch --copy-config --no-deploy
fly volumes create computer_workspace --size 20 --region syd
fly volumes create computer_config --size 2 --region syd
fly volumes create computer_hub --size 1 --region syd
fly secrets set COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
fly deploy
```

Volumes live in **syd**. Grow in place with `fly volumes extend <name> --size N` (TRIM/size: start 20 / 2 / 1 GB; Grok disk is 128 GB on workspace). One computer Machine — do not `fly scale count` the guest.

`vnc_url` carries a **short-lived pixel token** (15 min). Pairing still mints a durable seat token for Seat RPCs; that seat token still opens `/vnc` so existing iOS pair sessions keep working. `Seat.Status` reuses a still-valid pixel grant so the panel's noVNC iframe is not remounted every poll.

### Control panel on Vercel

[`apps/web`](apps/web) is a Next.js **server** app (Better Auth + auto-Pair). **Do not host the desk or hub on Vercel.** Do not proxy `/vnc` or `/websockify` — the iframe loads the absolute `vnc_url` the hub minted.

1. Import this repo (`mblode/expert-computer`).
2. Set the project **Root Directory** to `apps/web`.
3. Set `NEXT_PUBLIC_HUB_URL=https://mblode-computer.fly.dev` so Pair/Status go to the Fly computer. The hub echoes CORS on JSON RPC (`ACAO *`) so a `*.vercel.app` origin can read the response.

When that env is unset, a hosted page defaults the hub URL to `window.location.origin`. `localhost` / `127.0.0.1` still default to `http://127.0.0.1:8787`. See **Product web (Vercel)** below for the auth env table.

### Wake / sleep

| | What happens | Wakes the guest? |
|---|---|---|
| `Seat.Status`, `GET /roster`, `/healthz` | Edge answers from Fly Machines state | **no** |
| `/vnc`, `/websockify`, Pair, Agent, other Seat RPCs | Edge starts the computer, then proxies | yes |
| 20 min idle | Edge `suspend`s the computer | — |
| `npm run machine -- sleep` | stop (volumes persist) | — |
| `npm run machine -- wake` / `suspend` | explicit host control | — |

```sh
export FLY_API_TOKEN=…          # not in git
export FLY_APP_NAME=computer
npm run machine -- status       # cold — does not start the guest
npm run machine -- wake
npm run machine -- suspend
```

A computer update (`fly deploy`) replaces the guest image the same way a desk rebuild does: **apt packages do not survive**. `/workspace` and `~/.config` stay on volumes. `/data` (roster, seats, pairing code) stays too.

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
apps/desk/      Debian + Openbox + Chromium + X.Org (Xvfb) + x11vnc, XTEST input
apps/eve/       Eve agent (eve.dev): the harness — persona, skills, computer tools
apps/web/       Product web (Vercel): Better Auth + auto-Pair to the Fly hub
apps/ios/       Computer.xcodeproj (SwiftUI) — pairing client; iOS keeps setup-code pairing
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

Clipboard, `vncUrl`, and pointer are **not** model tools. VNC is view-only — x11vnc is `-viewonly` and localhost-only, so a viewer cannot inject input; input arrives only as `Seat.Pointer`/`Seat.Type`, which is what lets the hub enforce the seat.

**Many Bots, one box.** Each Bot owns a screen (window index = X display, `:1`–`:8`, x11vnc RFB `5900+N`, noVNC `6080+(N-1)`); its token is its identity — **agent token → Bot → screen**, the model never names a display. Bots are provisioned at runtime; the roster lives in `data/bots.json` locally (gitignored — it holds tokens) or `/data` on Fly. Bots are **not** security boundaries: one `box` user, shared `/workspace`.

Locally the hub binds `127.0.0.1`. On Fly the **edge** is public; the guest hub listens on the 6PN. Do not bind `0.0.0.0` on a machine that is not a Fly guest.

Agent LLM is BYO (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`); without it the hub still pairs, streams the desktop, and serves the four tools.

## Checks

```sh
npm run proto:check    # copy + buf lint + generate + gen/ committed
npm run lint           # layer rules
npm test               # hub tests
npm run typecheck --workspace=@computer/web
```

`api/computer.proto` is the source of truth; `packages/proto/gen` is committed output (TypeScript + Swift).

## Product web (Vercel)

`apps/web` is a Next.js **server** app (not a static export). The Vercel project Root Directory is `apps/web` (`prj_OkFZwmh7EcQgO6ThJ8EbaNLLWDbB`, team `blode`). Fly (`https://mblode-computer.fly.dev`) is the computer.

Required Vercel environment variables:

| Variable | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | Canonical origin, e.g. `https://your-app.vercel.app` |
| `TURSO_DATABASE_URL` | libSQL URL |
| `TURSO_AUTH_TOKEN` | Turso token |
| `RESEND_API_KEY` | OTP email. If unset, the code is logged to the server console |
| `AUTH_EMAIL_FROM` | Default `Computer <hello@send.blode.co>` |
| `COMPUTER_SETUP_CODE` | Same secret as the Fly hub. **Server-only** — never `NEXT_PUBLIC` |
| `NEXT_PUBLIC_HUB_URL` | `https://mblode-computer.fly.dev` |

Optional: `COMPUTER_HUB_URL` (server override of the hub origin), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` / `APPLE_APP_BUNDLE_IDENTIFIER`. Google and Apple buttons render only when both id and secret are present.

Push the Better Auth + `computer_seat` schema once:

```sh
cd apps/web && npx drizzle-kit push
```
