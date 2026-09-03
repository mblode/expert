# Eve on the computer

Eve is a process on the same machine as the hub and the desk, not a Vercel
app. Humans sign in at [hello.expert](https://hello.expert). The browser talks
to Eve only through the hub's `/eve/v1` proxy (seat token). Same machine,
loopback. See [eve.dev](https://eve.dev): the directory is the agent.

## Layout

```
apps/eve/lib/           shared tools, hub RPC, hubLoopbackAuth
apps/eve/bots/main/     the desk agent (roster bot on display 1, :2000)
```

Each bot is its own eve.dev project: `agent/instructions.md`, `agent/skills/`,
`agent/schedules/`. Shared typed tools (`computer`, `shell`, `read_file`,
`write_file`, `send_message`) live in `lib/` and are re-exported from the bot.

One **process** per bot. `COMPUTER_BOT_TOKEN` is that bot's identity and
screen. Port is `2000 + (display - 1)`.

## Add a bot

1. Copy `bots/main` to `bots/<id>` and add `apps/eve/bots/<id>` to the
   `workspaces` list in the root `package.json`.
2. Rewrite `agent/instructions.md` (and skills / schedules) for that bot.
3. Mint a token: `npm run bot -- new <id>` (or restore one on the volume).
4. On Fly, add an `eve build` line for it in `deploy/fly/Dockerfile` and
   deploy. The supervisor starts `eve start --host 127.0.0.1 --port …` only
   if `<id>` is on the roster and a project exists.

A tenant that is not this tree (for example Vibey's Eve app, which stays in
its own repo) is not copied here. Point `COMPUTER_EVE_BOTS` at it, or put
it on the guest volume at `/workspace/eve/bots` (either `bots/main` or a
standalone Eve project with `package.json` + `agent/`). The overlay wins
when that path looks like an Eve app.

Do not invent a setup code or pretend the agent holds a seat token.
Production is `eve start`, not `eve dev` / `EVE_DEV=1`.

## Enable WhatsApp on a Bot

WhatsApp is a channel of the computer, not a second agent. A Baileys bridge
(the hub supervises it on loopback, `docs/WHATSAPP-PARITY.md` Section 3)
logs into a linked number and POSTs each message to the Bot's Eve; the
reply goes back in the same response and the bridge posts it to the chat.

1. Re-export the shared channel from the bot:

   ```ts
   // apps/eve/bots/<id>/agent/channels/whatsapp.ts
   export { default } from "../../../../lib/channels/whatsapp.ts";
   ```

   The file stem is the channel id, and its presence is what enables the
   route `POST /eve/v1/whatsapp/message`. `bots/main` has it.

2. Re-export `lib/tools/expert_invite.ts` too, so the Bot has something to
   hand a chat user who wants the mouse (it answers `available: false` until
   the invite RPC lands in Phase 2).

3. Re-export `lib/tools/whatsapp_send.ts` for the outbound envelope: the one
   tool that reacts, quotes, or attaches a file, mirroring the bridge's single
   `POST /send-envelope`. The turn's final text is still the reply; this is for
   what a plain response cannot say. It reads the chat JID and the message id
   off the session (never off the model's copy of the context block), quotes
   the message being answered by default, and needs `WHATSAPP_BRIDGE_SECRET`
   plus `COMPUTER_BRIDGE_URL` (or `BRIDGE_URL`, default
   `http://127.0.0.1:2100`). The hub's supervisor keeps that secret out of an
   Eve child's environment on purpose, so on the Fly guest every send answers
   `available: false` until Phase 3 mints a per-inbound reply capability; the
   Bot answers in text either way.

The route accepts either of two headers, checked in constant time:

| Header                  | Secret                   | Path                                                                       |
| ----------------------- | ------------------------ | -------------------------------------------------------------------------- |
| `x-computer-eve-secret` | `COMPUTER_EVE_SECRET`    | Production. The hub's `/connectors/<id>/message` ingress on loopback       |
| `x-bridge-secret`       | `WHATSAPP_BRIDGE_SECRET` | Direct. A bridge with no hub in front, the eve TUI, or the Vercel fallback |

`COMPUTER_EVE_SECRET` is the hub-to-Eve secret this process already holds
for the `/eve/v1` proxy; the bridge never sees it. In production the bridge
authenticates to the hub with its own channel secret and the hub forwards
here with `x-computer-eve-secret`. Set `WHATSAPP_BRIDGE_SECRET` only when
something posts to Eve directly; leave it unset and that door stays shut.
With neither set the route answers 503.

The wire shape is bridge protocol v1 (`lib/channels/bridge-protocol.ts`):
`token` (the chat JID), `message`, optional `sender`, `senderPhone`,
`senderName`, `surface` (`dm` or `group`), `context[]`, `media[]` and
`acct`. Every `context` block is fenced as `<untrusted_context>` before
the model sees it, at most two images are attached, and each message runs
in a fresh session (`<jid>#<uuid>`) so the reply is never a prior turn's.
Replies pass through `lib/format-reply.ts` on the way out: single `*` bold,
no headings or em dashes, configured secrets and credential query params
redacted.

Tests: `npm test --workspace=apps/eve` (vitest over `lib/**/*.test.ts`;
nothing boots eve).

## Auth

`hubLoopbackAuth()` accepts `x-computer-eve-secret` from the hub. The hub
already gated on the seat token. `localDev()` stays for the REPL only and is
ignored by `eve start`.
