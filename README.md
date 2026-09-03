<div align="center">

# [Expert](https://hello.expert)

**A persistent Linux computer your AI agents drive and you can take the seat of**

Sign in, watch the screen, take over when the agent gets stuck, hand it back.

</div>

## Demo

Sign in at [hello.expert](https://hello.expert) to watch the desk and talk to the agent. One Fly Machine per tenant: Blode stays `mblode-computer`; Vibey is a second computer (`vcmc-computer`).

## Install

```bash
git clone https://github.com/mblode/expert && cd expert && npm install
```

Requires Node 24 and a running Docker daemon (Docker Desktop, OrbStack, colima). Without Docker the hub runs against a fake desk so you can still pair and poke around.

## Quickstart

```bash
# builds the desk container, starts the agent and the hub, prints a pairing QR
npm run up

# in a second terminal: the web client on http://localhost:3000
npm run web
```

Open the web client, sign in with an email code, and the desk appears: a 1280x800 Debian desktop with Chromium, streamed view-only. Give the agent something to do in the chat, and take the seat when it asks.

Provision more Bots, each on its own screen of the same box:

```bash
npm run bot -- new night   # Bot night is live on screen 2. token: bot_…
npm run bot -- ls          # main  screen 1  AGENT / night  screen 2  AGENT
npm run bot -- rm night    # frees the screen
```

## What you can do

- **Watch the agent work:** the screen streams live over VNC; the model sees screenshots, clicks by pixel, types, scrolls, zooms.
- **Take the seat:** one click makes the screen yours, with a local cursor, keyboard, and clipboard both ways. The agent's next action waits until you tap I'm done.
- **Let it ask:** passwords, 2FA, captchas and payments are the human's job. The agent hands the desk over, or asks for a masked secret that goes straight to the box clipboard and never reaches the model.
- **Run several Bots:** one shared box, one screen per Bot, up to eight. Bots share files and browser sessions and are not security boundaries.
- **Keep your files:** `/workspace` and the Chromium profiles survive restarts and image rebuilds, the same boundary Grok Bot draws. Installed packages do not; keep the list in `/workspace/packages.md`.

## Deploy

Step by step, with the check that proves each step worked: [docs/DEPLOY.md](docs/DEPLOY.md). The shape of it:

The cloud path is one Fly Machine per tenant in `syd` running the desk, one agent process per Bot, and the hub. Blode is [fly.toml](fly.toml). Vibey is a second app and volume, same guest image, from [fly.vcmc.toml](fly.vcmc.toml). Both guests are shared-cpu-2x / 2 GB and suspend when idle. Do not `fly deploy` without `-c` when you mean Vibey: that command targets `mblode-computer`.

```bash
# Blode (existing)
fly secrets set COMPUTER_SETUP_CODE="$(openssl rand -hex 16)"
fly secrets set AI_GATEWAY_API_KEY="…"
fly deploy

# Vibey (separate app, existing 10 GB `vcmc_workspace` in syd, setup code)
# Both suspend when idle: CPU/RAM go to $0; the volume still bills. Do not
# create a new volume. `fly deploy` without `-c` still targets Blode.
fly secrets set COMPUTER_SETUP_CODE="$(openssl rand -hex 16)" -c fly.vcmc.toml
fly secrets set AI_GATEWAY_API_KEY="…" -c fly.vcmc.toml
fly deploy -c fly.vcmc.toml
```

A later Eve tree that is not `apps/eve/bots/main` (the Vibey agent lives in its own repo) goes on that tenant's volume at `/workspace/eve/bots`. The guest prefers that overlay when it looks like an Eve project.

The product web is `apps/web` on Vercel with Root Directory `apps/web`. It is the control plane: a signed-in user is bound to a computer. Required variables:

| Variable                                 | Notes                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`                     | `openssl rand -base64 32`; production refuses to start without it                   |
| `BETTER_AUTH_URL`                        | `https://hello.expert`                                                              |
| `AUTH_ALLOWED_EMAILS`                    | Comma-separated. Unset means open sign-up                                           |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | libSQL                                                                              |
| `RESEND_API_KEY`                         | Sign-in codes by email; required in production                                      |
| `COMPUTER_SETUP_CODE`                    | Blode Fly hub secret; server-only                                                   |
| `COMPUTER_SETUP_CODE_VCMC`               | Vibey Fly hub secret; server-only. Not Blode's code                                 |
| `NEXT_PUBLIC_HUB_URL`                    | Blode's hub when no `COMPUTER_HUB_URL_BLODE`. Not a fallback for an unbound account |
| `COMPUTER_OPERATOR_EMAILS`               | Who may switch computers and mint invites. Unset: nobody                            |
| `COMPUTER_BINDINGS`                      | `email:blode,email:vibey`. An email with no binding gets no computer                |
| `INVITE_MINT_SECRET`                     | Mint secret for `/desk` and `/plugins` links. Alias of `EXPERT_INVITE_SECRET`       |
| `EXPERT_INVITE_SECRET`                   | Same mint secret. Eve sends it as `x-invite-secret` (WhatsApp)                      |

A WhatsApp tap opens a short-lived invite: `/desk/<token>` is the phone desk (take/yield seat, pointer, keyboard). `/plugins/<token>` adds an Eve connection file under `agent/connections/` on the guest. Plugins are files, not a database table. Skills stay as files too.

Push the schema once with `cd apps/web && npx drizzle-kit push`. An always-on VPS is the alternative: [deploy/cloud-init.yaml](deploy/cloud-init.yaml).

## Notes

- **The protocol is small on purpose:** five model tools (`send_message`, `computer`, `shell`, `read_file`, `write_file`) and a Seat service for humans. Clipboard, the VNC URL and the pointer are never model tools. [api/DESIGN.md](api/DESIGN.md) is the contract; [api/RESEARCH.md](api/RESEARCH.md) is the argument.
- **This is a clean-room clone of Grok Bot's computer:** what it is, how far this is from it, and the roadmap are in [docs/GROK-BOT.md](docs/GROK-BOT.md). The current engineering audit is [docs/AUDIT.md](docs/AUDIT.md).
- **Agents working on this repo** read [AGENTS.md](AGENTS.md): commands, layering rules, and the gotchas.

## License

Apache-2.0
