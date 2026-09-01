# Computer

A cloud-hosted Linux **computer** one person signs into from every client with **email one-time password**. Agents drive the desktop; you can take the seat.

iOS · web · Mac · Windows → hub (ConnectRPC) → desk (Docker, TigerVNC, one 1280×800 screen per Bot).

Sign-in is email OTP via Supabase Auth (`signInWithOtp`, 6-digit code). One computer per email: every client of that account attaches to the same desktop. The hub verifies the access token (`Seat.Session`) and maps `auth.users.id` onto the existing seat-token machinery. Product auth is TLS + that JWT. The hub still binds loopback; publish it over HTTPS (Tailscale Serve is fine for a local box).

Protocol: [api/DESIGN.md](api/DESIGN.md). Clean-room Apache-2.0 implementation of the Grok Bot desktop contract. The primary source is xAI's own Apache-2.0 publication — [`xai-org/grok-build`](https://github.com/xai-org/grok-build) ships the computer-hub wire protocol under `crates/common/` (`xai-tool-protocol`, `xai-computer-hub-core`, `xai-message-delivery-core`). [b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed) describes the 0.18 desktop app and is a secondary source, not a fork — note that it carries no licence grant. See [api/RESEARCH.md](api/RESEARCH.md) for what we take from each and what we refuse to read.

## Sign in

1. Open any client. Enter your email.
2. Type the 6-digit code from the message.
3. You land on the same computer — pixels, chat, seat — as every other signed-in client.

Clients talk to Supabase for OTP; the hub never sends mail. Wire the dedicated **Computer** Supabase project through env (see [.env.example](.env.example)). Leave real secrets out of git.

| Client | Where | Notes |
|---|---|---|
| Web | `apps/web` — first-class | `npm run web`. Served by the hub in production (`next export`). |
| Mac / Windows | `apps/desktop` — Tauri 2 wrapping the web client | `npm run desktop` (needs Rust). See [apps/desktop/README.md](apps/desktop/README.md). |
| iPhone | `apps/ios` — native SwiftUI | Email OTP is the default. Session in Keychain. |

## Local-dev fallback

Without Supabase, `npm run up` still works: it generates a setup code, prints a pairing QR, and `Seat.Pair` mints a seat token. That path is for a box on your own machine, not the product login.

```sh
git clone https://github.com/mblode/expert-computer && cd expert-computer
npm install
npm run up
```

You need a running Docker daemon (Docker Desktop, OrbStack, colima — anything the `docker` CLI talks to). Without Tailscale the hub still runs; open `http://127.0.0.1:8787` for the web client, or `http://127.0.0.1:8787/vnc/index.html?token=…` for pixels only. The desk is a Debian container running Xvnc at 1280×800 per screen, on amd64 and arm64.

Provision Bots on the fly — each gets its own screen on the shared box and a minted token (shown once):

```sh
npm run bot -- new night   # → Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

A signed-in seat is the box owner (`Seat.CreateBot` / `Seat.DeleteBot`).

## Eve as the harness

[Eve](https://eve.dev) (Vercel's agent framework) is the brain; this box is the body. `apps/eve/` is an Eve agent whose four tools are the computer — `computer` even hands the model screenshots as vision input — plus a persona (`agent/instructions.md`) and a computer-use playbook (`agent/skills/computer-use.md`).

```sh
npm run bot -- new eve      # prints the two lines for apps/eve/.env
cd apps/eve && cp .env.example .env   # paste token, set AI_GATEWAY_API_KEY
npm run eve                 # (from the root) talk to Eve in the dev REPL
```

Eve runs **on the box**, beside the hub, over loopback — nothing public. She keeps her state in `/workspace`, drives her own screen, and when she hits a 2FA prompt she calls `request_takeover`: the client banners, you take the seat, tap I'm done, she continues. Her first `shell` call each session asks you once (Eve's approval gate); everything else flows. Requires Node ≥24 for the Eve runtime (the hub itself runs on ≥20). Deploying Eve to Vercel instead works but needs a path back to the box — deliberately not the default.

Hub + desk are a standing Linux Docker host. They cannot live on Vercel or Workers. Fresh box: paste [deploy/cloud-init.yaml](deploy/cloud-init.yaml) into a new Ubuntu 24.04 VM, set the Supabase env, `npm run up`.

## Shape

```
apps/hub/       ConnectRPC, noVNC static, fallback chat loop, provisioning
apps/desk/      Debian + Openbox + Chromium + TigerVNC (Xvnc), XTEST input
apps/eve/       Eve agent (eve.dev): the harness — persona, skills, computer tools
apps/web/       First-class Next.js client (email OTP + computer UI)
apps/desktop/   Tauri 2 (macOS + Windows) wrapping apps/web
apps/ios/       Computer.xcodeproj (SwiftUI, iOS 18+)
packages/proto  buf generate (protoc-gen-es + Swift) from api/computer.proto
packages/shared branded IDs, error codes
scripts/        computer.mjs — up / qr / bot new|ls|rm|token
```

Two services. Four model tools. A seat per screen.

| Service | Audience | RPCs |
|---|---|---|
| `Agent` | model | Spec, Computer, Shell, ReadFile, WriteFile |
| `Seat` | signed-in human | Session, Pair, Status, SetPresence, Pointer, Type, ClipboardGet, ClipboardSet, CreateBot, DeleteBot |

Clipboard, `vncUrl`, and pointer are **not** model tools. VNC is view-only — the X server refuses RFB key and pointer events outright, so a viewer cannot touch the box; input arrives only as `Seat.Pointer`/`Seat.Type`, which is what lets the hub enforce the seat.

**Many Bots, one box.** Each Bot owns a screen (window index = X display, `:1`–`:8`, RFB on `5900 + N`); its token is its identity — **agent token → Bot → screen**, the model never names a display. Bots are provisioned at runtime; the roster lives in `data/bots.json` (gitignored — it holds tokens). Bots are **not** security boundaries: one `box` user, shared `/workspace`.

## What survives

Two paths persist, and that is Grok Bot's own boundary — matched deliberately, so a skill written for a Bot needs no edit here.

| | `docker compose restart` | rebuild (`npm run up`, `up --build`) | `down -v` |
|---|:--:|:--:|:--:|
| `/workspace` — files, the Bot's own state | yes | yes | no |
| `~/.config` — every Chromium profile, app config | yes | yes | no |
| `~/.local/state` — WhatsApp/Signal linked devices | yes | **no** | no |
| `~/.ssh`, `~/.gitconfig`, anything else in `~` | yes | **no** | no |
| `apt install`ed packages | yes | **no** | no |
| running processes, `/tmp`, X displays | no | no | no |

The bold cells are the ones that bite. A rebuild replaces the image, so packages go with it — keep the list in `/workspace/packages.txt` and have the agent reinstall after an update, the same drill Grok users are given. A linked-device session under `~/.local/state` has to be re-scanned. Anything else you want to keep, put in `/workspace` and symlink.

Window claims live in `/workspace/.window-assignments.json`, so a rebuild does not cost a Bot its screen — the desk restarts every window it had.

Each Bot's own state is under `/workspace/.bots/<id>/` for the same reason: `profile.json`, `memory/profile.md`, and its thread as `transcript.jsonl`. Grok keeps this in `~/sand-data`, which on this box a rebuild would erase. The Bot's **token is not there** — `data/bots.json` on the host is the only place a bearer lives, and the box only ever sees `sha256(token)`. Bots are not security boundaries, so every Bot can read every other Bot's directory. Deleting a Bot frees its screen and its roster row and leaves the directory alone; `rm -rf` it from the desk to be rid of it.

## Compute

Provider-agnostic: any Linux machine that stays on and runs Docker — a Hetzner/DO VM, a spare mini PC. Vercel/Cloudflare Workers/Railway can't host a standing desktop. The hub binds `127.0.0.1`. Do not bind `0.0.0.0`. Product auth is the Supabase JWT, not the network overlay.

Agent LLM is BYO (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`); without it the hub still signs in, streams the desktop, and serves the four tools.

## iPhone

Open `apps/ios/Computer.xcodeproj` on a Mac. Email OTP is the launch path; the session is in Keychain. Pairing (setup code / QR) is still there as a hidden/dev path. TestFlight, not App Store.

Set `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `COMPUTER_HUB_URL` in the Xcode build settings (see `.env.example`).

```sh
xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

## Checks

```sh
npm run proto:check    # copy + buf lint + generate + gen/ committed
npm run lint           # layer rules
npm test               # hub tests (includes JWT Session)
npm test --workspace=@computer/web
```

`api/computer.proto` is the source of truth; `packages/proto/gen` is committed output (TypeScript + Swift).
