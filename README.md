# Computer

A persistent Linux **computer** that agents drive and a human can take the seat of.

This repository is the compute substrate and its clients. The product site is [hello.expert](https://hello.expert) (`apps/web` on Vercel); the computer is a Fly Machine in `syd`. One deployment fronts **one** computer: every account that signs in shares it. Per-account machines are on the roadmap ([docs/GROK-BOT.md](docs/GROK-BOT.md)).

```
local:   docker compose  →  the guest (Debian + box + Xvfb + x11vnc), hub on the host
cloud:   Fly Machine     →  the same guest, hub and Eve inside it
```

Protocol: [api/DESIGN.md](api/DESIGN.md). Clean-room Apache-2.0 implementation of the Grok Bot desktop contract; see [api/RESEARCH.md](api/RESEARCH.md) for what was taken from where, and [docs/GROK-BOT.md](docs/GROK-BOT.md) for what Grok Bot is and how far this is from it. [docs/AUDIT.md](docs/AUDIT.md) is the current engineering audit.

## Grok mapping

| | Grok / Anyrun | This repo |
|---|---|---|
| Prod host | Cursor Anyrun: Firecracker on EC2 (private) | **Fly Machine** in **syd** ([fly.toml](fly.toml)) |
| Guest image | Docker-built Debian, user `box` | same: `apps/desk` Debian, non-root `box` |
| Display | X.Org 1280×800, `:1` + forks `:2+` | Xvfb 1280×800, one screen per Bot |
| Pixels | x11vnc → websockify → noVNC | **x11vnc** view-only → the hub's websockify → noVNC |
| Exec | ConnectRPC hub on loopback | same shape; input is Seat + XTEST, never RFB |
| Sleep | memory+disk snapshot, wake-on-connect | **none yet**: the Machine stays running (`auto_stop_machines = "off"`) |
| Local | Docker container | `docker compose` — the same guest |

## Quick start (local)

```sh
npm install
npm run up       # generates .env, builds the desk, starts Eve and the hub, prints the pairing QR
```

You need a running Docker daemon (Docker Desktop, OrbStack, colima). Without one the hub runs against a fake desk so you can still pair and poke around.

The hub binds `127.0.0.1:8787`. If Tailscale is installed, `up` publishes it with Tailscale Serve and the QR carries that URL. The desk is a Debian container: Xvfb 1280×800, x11vnc on localhost, amd64 and arm64. `docker compose up --build` is the same desk without the hub.

Provision Bots on the fly — each gets its own screen on the shared box and a minted token (shown once):

```sh
npm run bot -- new night   # → Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

The CLI pairs once and keeps its seat token in `.env`. A paired seat is the box owner (`Seat.CreateBot` / `Seat.DeleteBot`).

Product web in dev: `npm run web` (Next.js on :3000, Seat and Eve paths rewritten onto the local hub). See `apps/web/.env.example`.

## Cloud (Fly Machine in syd)

One process group in [fly.toml](fly.toml): `computer` = desk + one Eve per roster bot + hub, under `tini`. Start at shared-cpu-4x / 4 GB; Grok's measured SKU is 8 vCPU / 16 GB / 128 GB.

```sh
# once per account — change `app` in fly.toml; names are global
fly launch --copy-config --no-deploy
fly volumes create computer_workspace --size 20 --region syd
fly secrets set COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
fly secrets set AI_GATEWAY_API_KEY="…"
fly deploy
```

Set `COMPUTER_SETUP_CODE` as a Fly secret. If it is missing, the guest mints one onto the volume, where anything running as `box` (the model included) can read it.

One volume: `computer_workspace` → `/workspace` (desk files, `.computer` roster / seat tokens / Eve secret). Grow it in place with `fly volumes extend`. One Machine — do not `fly scale count` the guest. Every `fly deploy` restarts it (`strategy = "immediate"`), which kills running Chromium and Eve turns.

`vnc_url` carries a 15-minute pixel token bound to one display. Pairing mints a durable seat token for Seat RPCs; `Seat.Status` reuses a still-valid pixel grant so a viewer is not remounted every poll.

```sh
export FLY_API_TOKEN=…          # not in git
export FLY_APP_NAME=mblode-computer
npm run machine -- status | wake | sleep | suspend
```

### Product site on Vercel (hello.expert)

[`apps/web`](apps/web) is a Next.js **server** app (Better Auth + auto-Pair). Do not host the desk or hub on Vercel. Do not proxy `/vnc` or `/websockify` — the iframe loads the absolute `vnc_url` the hub minted.

1. Import this repo; set the project **Root Directory** to `apps/web`.
2. Set the variables below. The hub echoes CORS on JSON RPC so the Vercel origin can call it.
3. Push the schema once: `cd apps/web && npx drizzle-kit push`.

| Variable | Notes |
|---|---|
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32`. **Required**; production refuses to start without it |
| `BETTER_AUTH_URL` | `https://hello.expert` |
| `AUTH_ALLOWED_EMAILS` | Comma-separated. Unset = open sign-up, and every sign-up owns the computer |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | libSQL |
| `RESEND_API_KEY` | OTP email. **Required in production** |
| `AUTH_EMAIL_FROM` | Default `Expert <hello@send.blode.co>` |
| `COMPUTER_SETUP_CODE` | Same secret as the Fly hub. Server-only, never `NEXT_PUBLIC` |
| `NEXT_PUBLIC_HUB_URL` | `https://mblode-computer.fly.dev` |

Optional: `COMPUTER_HUB_URL` (server-side override of the hub origin), `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `APPLE_CLIENT_ID` / `APPLE_CLIENT_SECRET` / `APPLE_APP_BUNDLE_IDENTIFIER`.

## What survives

Two guest paths persist, and that is Grok Bot's own boundary — matched deliberately, so a skill written for a Bot needs no edit here.

| | compose restart / Machine restart | rebuild / `fly deploy` | `down -v` / destroy volume |
|---|:--:|:--:|:--:|
| `/workspace` — files, the Bot's own state, the hub roster and seat tokens | yes | yes | no |
| `~/.config` — every Chromium profile (compose volume; **on the image on Fly**) | yes | compose yes, Fly **no** | no |
| `~/.local/state` — WhatsApp/Signal linked devices | yes | **no** | no |
| `~/.ssh`, `~/.gitconfig`, anything else in `~` | yes | **no** | no |
| `apt install`ed packages | yes | **no** | no |
| running processes, `/tmp`, X displays | no | no | no |

The bold cells bite. A rebuild replaces the image, so packages go with it — keep the list in `/workspace/packages.md` and have the agent reinstall after an update, the same drill Grok users are given. On Fly, put Chromium profiles you care about under `/workspace` and symlink, or bind a second volume.

Window claims live in `/workspace/.window-assignments.json`, so a rebuild does not cost a Bot its screen. Each Bot's own state is under `/workspace/.bots/<id>/`: `profile.json`, `memory/profile.md`, `transcript.jsonl`. The Bot's **token is not there** — the roster (`data/bots.json` locally, `/workspace/.computer/bots.json` on Fly) is the only place a bearer lives. Locally the box only ever sees `sha256(token)`; on Fly the roster is on the shared volume and readable by `box`. Bots are not security boundaries. Deleting a Bot frees its screen and roster row and leaves its directory alone.

## Always-hot alternate (Hetzner)

Paste [deploy/cloud-init.yaml](deploy/cloud-init.yaml) into a new Ubuntu 24.04 VM, `tailscale up`, then `npm run up` from a shell with the Docker daemon running. The VM stays billed while it runs.

## Eve as the harness

[Eve](https://eve.dev) runs **inside the computer** — the same machine as the hub and the desk. Humans sign in at hello.expert; the web client talks to Eve only through the hub's `/eve/v1` proxy (seat token). Same machine, loopback.

One Eve **process** per roster bot (`COMPUTER_BOT_TOKEN` is that bot's identity and screen). Each bot is an eve.dev project at `apps/eve/bots/<id>/`; shared tools live in `apps/eve/lib/`. Port is `2000 + (display - 1)`. See [apps/eve/README.md](apps/eve/README.md) for adding one.

Model access is `AI_GATEWAY_API_KEY` (Vercel AI Gateway) on the guest. Without it the hub still pairs, streams the desktop, and serves the five tools; Eve starts but model calls fail.

## Shape

```
api/            DESIGN.md (contract), computer.proto, spec.json, RESEARCH.md
apps/hub/       the hub: Connect-style JSON RPCs, noVNC static + websockify, provisioning, policy
apps/desk/      Debian + Openbox + Chromium + Xvfb + x11vnc, XTEST input; packages.txt is the apt list
apps/eve/       Eve on the guest: shared lib + one project per bot under bots/
apps/web/       hello.expert (Vercel): marketing + Better Auth + auto-Pair
apps/ios/       Computer.xcodeproj (SwiftUI) — setup-code pairing client
packages/proto  buf generate (protoc-gen-es + Swift) from api/computer.proto
packages/shared branded IDs, error codes, action types
deploy/fly/     guest image + entrypoint for the Fly Machine
scripts/        computer.mjs (up / qr / bot), lint-layers, proto-check
docs/           AUDIT.md, GROK-BOT.md, history/
```

Two services. Five model tools. A seat per screen.

| Service | Audience | RPCs |
|---|---|---|
| `Agent` | model | Spec, SendMessage, Computer, Shell, ReadFile, WriteFile |
| `Seat` | human | Pair, Status, SetPresence, Pointer, Type, ClipboardGet, ClipboardSet, Occurrences, ProvideSecret, CreateBot, DeleteBot |

Clipboard, `vnc_url`, and pointer are **not** model tools. VNC is view-only — x11vnc is `-viewonly` and localhost-only — so a viewer cannot inject input; input arrives only as `Seat.Pointer`/`Seat.Type`, which is what lets the hub enforce the seat.

Hub layers: `handler` (HTTP) → `service` (seat, computer, files, voice, policy, provisioning) → `desk` (docker exec / local exec, XTEST). `npm run lint` enforces the direction.

Locally the hub binds `127.0.0.1`. On Fly the guest hub is the public `http_service`. Do not bind `0.0.0.0` on a machine that is not a Fly guest.

## Checks

```sh
npm run check          # typecheck + lint (layers, oxlint) + hub tests + proto:check
npm run typecheck      # every workspace, apps/eve included
npm run lint
npm test
npm run proto:check    # copy + buf lint + generate + gen/ committed
```

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs those, builds the web app, shellchecks the desk scripts, lints both Dockerfiles, and boots the desk image to assert a 1280×800 screenshot.

`api/computer.proto` is the source of truth; `packages/proto/gen` is committed output (TypeScript + Swift). Agent skill: `npx skills add https://hello.expert` ([skills/expert/SKILL.md](skills/expert/SKILL.md)).
