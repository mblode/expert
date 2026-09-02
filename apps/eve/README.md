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

A tenant that is not this tree (for example VCMC's Eve app, which stays in
its own repo) is not copied here. Point `COMPUTER_EVE_BOTS` at it, or put
it on the guest volume at `/workspace/eve/bots` (either `bots/main` or a
standalone Eve project with `package.json` + `agent/`). The overlay wins
when that path looks like an Eve app.

Do not invent a setup code or pretend the agent holds a seat token.
Production is `eve start`, not `eve dev` / `EVE_DEV=1`.

## Auth

`hubLoopbackAuth()` accepts `x-computer-eve-secret` from the hub. The hub
already gated on the seat token. `localDev()` stays for the REPL only and is
ignored by `eve start`.
