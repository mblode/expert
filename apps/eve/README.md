# Eve on the computer

Eve is a process on the same machine as the hub and the desk, not a Vercel
app. Humans sign in at [hello.expert](https://hello.expert). The browser talks
to Eve only through the hub's `/eve/v1` proxy (seat token). Same machine,
loopback. See [eve.dev](https://eve.dev): the directory is the agent.

## Layout

```
apps/eve/lib/                    shared tools, hub RPC, channels, hubLoopbackAuth
apps/eve/lib/vibey/              the agent ported from vcmc-agent on 2026-09-06: memory
                                 store and screens, chat archive search, roster, digest,
                                 consolidation, bridge client. Generic code; the community
                                 it serves is data on the volume (below).
apps/eve/lib/tools/              every model tool; bots re-export the ones they carry
apps/eve/bots/main/              the one shipped Bot (display 1, :2000)
apps/eve/bots/<id>/              one directory per Bot, and that is the Bot
```

## One build, every computer

The same image runs Vibey's computer and a stranger's. What makes one of
them Vibey is `/workspace/.bots/<id>/data/` on its volume, read by
`lib/vibey/chat-archive-source.ts` (`COMPUTER_BOT_DATA` overrides the path):

| File                 | What                                                       | Read by                                                                     |
| -------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| `chat-archive.b64`   | the group's history, gzip then base64, one file            | `search-chat`, `who-is`, `get-group-stats`, `get-reactions`, `audit-memory` |
| `members.json`       | the member overlay, `[{ phone, name, aliases?, tags, … }]` | `who-is`, the roster, the stale-fact scan                                   |
| `group-history.json` | `{ context: {…}, timeline: [{ date, summary, people? }] }` | `group-history`                                                             |

Absent files are an empty community: every one of those tools answers
`{ available: false }` and the instructions tell the Bot to say so. The
files are never in this repository (it is public and they name real
people); `docs/plans/vibey-on-expert.md` says where they come from. The
Bot's identity is the same shape: `agent/instructions.md` is the generic
default, and the runtime instructions the hub holds (edited from
hello.expert) are what make a computer Vibey.

The memory suite still lives on Vercel Blob (`BLOB_READ_WRITE_TOKEN`), the
bridge tools reach the community bridge at `BRIDGE_URL` with
`VIBEY_BRIDGE_SECRET`, and `read-url` wants `FIRECRAWL_API_KEY`. All three
are Fly secrets on the tenant and reach the Eve child through the
supervisor; none is on argv.

Each bot is its own eve.dev project: `agent/profile.json`,
`agent/instructions.md`, `agent/skills/`, `agent/schedules/`, and
`agent/channels/` for a door something else can knock on. Shared typed tools
(`computer`, `shell`, `read_file`, `write_file`, `send_message`) live in
`lib/` and are re-exported from the bot.

One **process** per bot, while that bot is awake. `COMPUTER_BOT_TOKEN` is its
identity and its screen; the port is `2000 + (display - 1)`. The build ships one Bot, `main`;
[`docs/BOTS.md`](../../docs/BOTS.md) says what it owns and how a second is made.

## Add a bot

1. Copy `bots/main` to `bots/<id>`. The root `package.json` globs
   `apps/eve/bots/*`, so there is no workspace list to edit.
2. Write `agent/profile.json`: the name, the label, the description and the
   mark (a shape and a colour from `AVATAR_SHAPES` / `AVATAR_COLORS` in
   `packages/shared`). The hub seeds it into `/workspace/.bots/<id>/` the
   first time that Bot boots and never again, so a later rename by the human
   or by the Bot itself survives every deploy.
3. Rewrite `agent/instructions.md` and its skills, schedules and channels. A
   Bot with schedules also lists them in `agent/routines.json` as
   `{ id, cron }`: it sleeps when nobody is using it, and that file is how the
   hub knows to wake it a minute before one is due. A test fails if the two
   drift. A shipped Bot's identity is in `instructions.md`, so it does not
   need the template's `agent/instructions/profile.ts`: that resolver reads
   `/workspace/.bots/<id>/profile.json` at `turn.started` and is the only
   thing telling two Bots on the shared template project apart. Re-export it
   when a rename from the settings sheet should reach the prompt here too.
4. Add a `COPY` line for its `package.json` in `deploy/fly/Dockerfile` (one
   per bot: a wildcard `COPY` flattens them onto one path) and deploy. The
   image builds every project under `apps/eve/bots`, the guest's init mints a
   roster row and a token for any project that has none, on the lowest free
   screen, and the supervisor registers it. Production runs the built server
   (`node .output/server/index.mjs`, 224 MB) rather than `npx eve start`
   (690 MB for the same agent), and only the primary Bot runs at boot: the
   rest are started when something asks for them and stopped when they go
   quiet.

Sixteen screens is the ceiling (`MAX_DISPLAYS`), so a project past that boots with
a warning and no screen. Deleting a Bot whose project is still in the image
frees its screen only until the next boot: removing one for good means
removing its directory.

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

## Wake a Bot on an event

A schedule wakes a Bot at a time; a webhook wakes it when something
happened. `lib/channels/webhook.ts` is the second half, generic over the Bot
and over what fires it:

```ts
// apps/eve/bots/qa/agent/channels/incident.ts
import { webhookChannel } from "../../../../lib/channels/webhook.ts";

export default webhookChannel({
  handling: "Triage it. Follow `skills/incident`.",
  kind: "incident",
  purpose: "Something upstream thinks a product is unhealthy.",
});
```

The file stem is the channel id and has to match the connector's kind, which
is what makes the hub's ingress land on `/eve/v1/incident/event`:

```sh
npm run bot -- connector add pagerduty incident qa
# POST https://<computer>/connectors/pagerduty/event  (x-connector-secret)
```

The door is the connector, so the credential is hub-minted and revocable on
its own and the sender never sees a seat token. There is no direct door: the
only accepted header is `x-computer-eve-secret`, from the hub on loopback.

The hub does not record the payload yet: its ingress binds a conversation for
`whatsapp` only, so an event arrives with no turn token and whatever the Bot
says with `send_message` lands in the owner's seat thread. The alert itself
is in the Bot's Eve log and nowhere else, which is the gap to close when a
`webhook` conversation route lands.

The payload is a stranger's. It is truncated at 16k characters, its fences
neutralised, wrapped in `<untrusted_context>`, and the wake says in the same
breath that it is evidence and not instructions. The route answers 202 with
the session id rather than the turn's text: an alerting system wants its
POST to return, and what the Bot has to say goes through `send_message`.

## Auth

`hubLoopbackAuth()` accepts `x-computer-eve-secret` from the hub. The hub
already gated on the seat token. `localDev()` stays for the REPL only and is
ignored by `eve start`.
