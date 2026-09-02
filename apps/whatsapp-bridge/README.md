# WhatsApp bridge

A multi-account [Baileys](https://github.com/WhiskeySockets/Baileys) process that links real WhatsApp numbers to Bots on this computer. It runs on the tenant's Fly Machine as a child of the hub, under the hub's UID, and listens on loopback only. Nothing about a tenant lives in the code: every linked number is one entry in `accounts.json`, and everything that used to be a Railway variable is that entry's `config`.

> This automates a normal WhatsApp account, which is against WhatsApp's Terms of Service, and the number can be banned. Use a dedicated number, never a personal one.

```
WhatsApp group / DM
     │  one Baileys socket per account
     ▼
whatsapp-bridge :2100  (this process; hub-supervised; hub UID; loopback)
     │  POST ${COMPUTER_URL}/channels/<channel_id>/message   x-channel-secret
     ▼
hub :8080  ── x-computer-eve-secret ──►  Bot's Eve  ── reply in the response
     ▲
     │  Bot tools call back: /messages, /resources, /send, /send-media ...   x-bridge-secret
```

Inbound: a message that should get a reply is POSTed to the hub's channel ingress with the account's `channel_secret`. The body is bridge protocol v1 (`token`, `message`, `sender`, `senderPhone`, `senderName`, `context[]`, `surface`, `media[]`) plus `acct`. The hub answers `{ reply }`, which the bridge posts back into the chat. Transient failures (429, 5xx, timeouts) are retried three times with backoff; a final failure sends a short "something went wrong" note so the user who watched "typing" start is not left in silence.

## Run

```bash
npm start --workspace=apps/whatsapp-bridge      # tsx src/index.ts
npm test --workspace=apps/whatsapp-bridge       # node --test via tsx
npm run typecheck --workspace=apps/whatsapp-bridge
```

The hub starts it in production (`apps/hub/src/host/start-bridge.ts`, Phase 1 of `docs/WHATSAPP-PARITY.md`), probes `GET /health`, and restarts it with backoff. Locally, point it at a running hub and give it a state dir you own:

```bash
WHATSAPP_BRIDGE_SECRET=dev WHATSAPP_STATE_DIR=./.wa-state WHATSAPP_DATA_DIR=./.wa-data \
  npm start --workspace=apps/whatsapp-bridge
```

## Env

| Name                     | Default                         | What                                                                                                                                                              |
| ------------------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOST`                   | `127.0.0.1`                     | Bind address. Keep it loopback: the hub is the only caller.                                                                                                       |
| `PORT`                   | `2100`                          | HTTP API port.                                                                                                                                                    |
| `WHATSAPP_BRIDGE_SECRET` | required                        | Every route except `GET /health` needs `x-bridge-secret` equal to it. The hub holds it; Eve tools get it from the hub, never from env.                            |
| `COMPUTER_URL`           | `http://127.0.0.1:8080`         | The hub. Inbound messages go to `${COMPUTER_URL}/channels/<channel_id>/message`.                                                                                  |
| `WHATSAPP_STATE_DIR`     | `/workspace/.computer/whatsapp` | `accounts.json` and `<acct>/auth/` (Baileys creds and signal keys). Secret. See below.                                                                            |
| `WHATSAPP_DATA_DIR`      | `/workspace/whatsapp`           | Per-account store under `<acct>/`: messages, resources, reactions, participants, lid map. Readable, no secrets.                                                   |
| `AI_GATEWAY_API_KEY`     | unset                           | Enables voice-note transcription through the Vercel AI Gateway (`TRANSCRIBE_MODEL`, default `openai/gpt-4o-mini-transcribe`). Unset = voice notes stay `[audio]`. |
| `LOG_LEVEL`              | `info`                          | pino level.                                                                                                                                                       |

Process-wide tuning knobs, all optional: `AGENT_TIMEOUT_MS` (40000), `MESSAGES_CAP` (50000), `REACTIONS_CAP` (50000), `SHUTDOWN_DRAIN_MS` (8000), `SYNC_FULL_HISTORY` (`true`), `MAX_IMAGE_BYTES` (4MB), `DOCS_ENABLED` (`true`), `MAX_DOC_BYTES` (3MB), `MAX_PDF_PAGES` (100), `AUDIO_ENABLED` (`true`), `MAX_AUDIO_BYTES` (16MB), `MAX_AUDIO_SECONDS` (600), `TRANSCRIBE_TIMEOUT_MS` (30000), `MAX_SEND_MEDIA_BYTES` (8MB). Secrets are read from env only; never put one on argv.

## The state dir is hub-owned. The model must never read it.

`WHATSAPP_STATE_DIR` holds two kinds of credential: each account's `channel_secret` (whoever has it can forge inbound messages to that Bot through the hub) and each account's Baileys auth state (whoever has it _is_ the WhatsApp account). The bridge creates the directory at `0700` and writes `accounts.json` at `0600`, and the hub runs it as the hub UID, so the `box` user the model's `shell`, `read_file` and `write_file` run as cannot open it. Do not relax those modes, do not copy the directory anywhere the model can reach, and do not add a route that returns a secret: `GET /accounts` deliberately omits `channel_secret`, and the QR and pairing code are served only on the authenticated link route, held in memory, and cleared the moment the socket opens. `WHATSAPP_DATA_DIR` is the other half of the split: chat data with no secrets in it, which is why it lives outside `.computer`.

## accounts.json

```json
{
  "version": 1,
  "accounts": [
    {
      "acct": "main",
      "bot": "main",
      "phone": "61400000000",
      "channel_id": "whatsapp-main",
      "channel_secret": "…",
      "config": {
        "group_policy": "all",
        "allowed_groups": [],
        "trigger_mode": "mention",
        "trigger_prefix": "!bot",
        "dm_policy": "members",
        "dm_allowlist": [],
        "image_sends_per_day": 20,
        "vision_enabled": true,
        "maintainer_jid": "",
        "owner_jids": [],
        "digest_recipient_jids": [],
        "bot_name": "Vibey",
        "members_overlay_file": ""
      }
    }
  ]
}
```

- `acct` matches `^[a-z0-9][a-z0-9-]{0,31}$` and names the auth and data directories.
- `bot` is the hub Bot id. `channel_id` (default `whatsapp`) is the hub channel the bridge posts to; the hub sets it when it creates the account. `phone` is digits only, no `+`, `null` until a link; a QR link fills it in from the socket.
- `config` is validated on load and on `PUT`; every omitted field takes its default, a wrong type is a `400` naming the field, unknown keys are dropped. Changes apply live: the allowlist, trigger, DM policy, image cap and bot name are read on every message, and a change to the group policy re-seeds the live participant set.

Config fields:

| Field                   | Default   | Meaning                                                                                                                                                             |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `group_policy`          | `all`     | `all` serves every group the number is in and ignores the list; `listed` serves only `allowed_groups`, and an empty list under it serves none.                      |
| `allowed_groups`        | `[]`      | Group JIDs (`…@g.us`), used by `listed`.                                                                                                                            |
| `trigger_mode`          | `mention` | `mention`: reply on an explicit @mention (quoting the bot does not count). `prefix`: messages starting with `trigger_prefix`. `all`: every group message (noisy).   |
| `trigger_prefix`        | `!bot`    |                                                                                                                                                                     |
| `dm_policy`             | `members` | `members`: live participants of an allowed group (fails open until seeded). `allowlist`: `dm_allowlist` only. `anyone`: every DM. The self-chat is always answered. |
| `dm_allowlist`          | `[]`      | Phones in any format or full JIDs (`…@s.whatsapp.net`, `…@lid`).                                                                                                    |
| `image_sends_per_day`   | `20`      | Per-chat daily cap on `POST /send-media`.                                                                                                                           |
| `vision_enabled`        | `true`    | Download shared images (and a quoted image) and forward them so the Bot can see them.                                                                               |
| `maintainer_jid`        | `""`      | Where `/report` and `/invite` DMs land. Empty = accepted, not delivered.                                                                                            |
| `owner_jids`            | `[]`      | Who may _receive_ a proactive `POST /send`. Has no effect on inbound routing.                                                                                       |
| `digest_recipient_jids` | `[]`      | Extra `POST /send` recipients (the daily digest), kept apart from owners so the two lists stay independently auditable.                                             |
| `bot_name`              | `Vibey`   | Labels the bot's own transcript rows and is the textual `@name` that counts as a mention in a DM.                                                                   |
| `members_overlay_file`  | `""`      | Path to a JSON array of `Member` rows (`{ phone, name, tags, … }`) merged onto the live roster by phone. Names and profiles only; it never gates anything.          |

Every account in the file gets a socket on boot, each with its own `useMultiFileAuthState` directory and a `makeCacheableSignalKeyStore`. An unlinked account tries to pair a few times, then goes idle until `POST …/link`; a device logged out from the phone has its creds deleted and reports `unlinked`.

## HTTP API

JSON in and out. Every route except `GET /health` requires `x-bridge-secret`.

### Accounts

| Method   | Route                         | Body / query                                         | Returns                                                                                                                                                                                                              |
| -------- | ----------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`    | `/health`                     |                                                      | `{ ok: true, accounts: [{ acct, whatsapp, lastCloseCode, failingSince, attempts }] }`. `whatsapp` is `open`, `connecting`, `close` or `unlinked`. No auth. Always 200: a socket still pairing is not a dead process. |
| `GET`    | `/accounts`                   |                                                      | `{ accounts: [{ acct, bot, phone, channel_id, status, display_name? }] }`. Never the secret.                                                                                                                         |
| `POST`   | `/accounts`                   | `{ acct, bot, channel_secret, channel_id?, phone? }` | `201 { acct }` and the socket starts. `409` if the id exists, `400` on a bad body.                                                                                                                                   |
| `DELETE` | `/accounts/:acct`             |                                                      | Logs the device out, deletes the auth dir, removes the entry. The data store stays.                                                                                                                                  |
| `POST`   | `/accounts/:acct/link`        | `{ phone? }`                                         | (Re)starts linking. With `phone` (digits, no `+`) the bridge calls `requestPairingCode` and holds the code; without it, it holds the latest QR. Returns the link state.                                              |
| `GET`    | `/accounts/:acct/link`        |                                                      | `{ acct, status, qr, pairing_code, age_ms, phone }`. `status` is `unlinked`, `linking`, `open` or `closed` (linked, socket reconnecting). A linked socket never serves a QR or code.                                 |
| `GET`    | `/accounts/:acct/groups`      |                                                      | `{ groups: [{ jid, subject, size, enabled }] }` from `groupFetchAllParticipating()`; `enabled` follows the group policy.                                                                                             |
| `POST`   | `/accounts/:acct/groups/join` | `{ invite }`                                         | A `chat.whatsapp.com` link or a bare code → `{ jid }`. The new group is seeded at once.                                                                                                                              |
| `GET`    | `/accounts/:acct/config`      |                                                      | `{ config }`, every field populated.                                                                                                                                                                                 |
| `PUT`    | `/accounts/:acct/config`      | `{ config }`                                         | Validated, persisted, applied live → `{ config }`.                                                                                                                                                                   |

Routes that need a live socket (`groups`, `groups/join`, `backfill`, the sends) answer `503` while it is down.

### Data routes (what a Bot's tools call)

These keep the shapes `vcmc-agent` already speaks. `acct` is a query param on `GET` and a body field on `POST`; when the process has exactly one account it may be omitted, otherwise it is a `400`.

| Method | Route                       | Purpose                                                                                                                                                                                                                                                      |
| ------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET`  | `/messages?group=<jid>&n=`  | Recent messages `{ messages: [{ t, s, n, x, id?, role?, surface? }] }`. `n` default 150, max 2000.                                                                                                                                                           |
| `GET`  | `/resources?group=<jid>&n=` | Recent shared links `{ resources: [{ t, s, n, url }] }`. `n` default 40, max 200.                                                                                                                                                                            |
| `GET`  | `/reactions?group=<jid>&n=` | Recent emoji reactions `{ reactions: [{ t, s, n, target, emoji }] }`. `n` default 200, max 5000.                                                                                                                                                             |
| `GET`  | `/members`                  | Live participants merged with the overlay `{ members, ready }`. `ready` is false until the live set has been loaded or seeded.                                                                                                                               |
| `GET`  | `/export?group=<jid>`       | Every stored message for a group, for an offline reingest.                                                                                                                                                                                                   |
| `POST` | `/backfill`                 | `{ group, n? }`: ask WhatsApp for older history, anchored on the oldest message seen. Results arrive through history sync.                                                                                                                                   |
| `POST` | `/report`                   | `{ kind?, summary, details?, requestedBy? }`: DM the maintainer a feature request or bug report. Deduped.                                                                                                                                                    |
| `POST` | `/invite`                   | `{ fullName, phone, email?, linkedIn?, note?, requestedBy?, source? }`: DM the maintainer a member referral. Deduped.                                                                                                                                        |
| `POST` | `/send`                     | `{ jid, text, idempotencyKey? }`: a proactive DM. **DM only**: a group JID is refused with `403` in code, before any allowlist. Target must be the maintainer, an owner or a digest recipient. A replayed `idempotencyKey` collapses onto the original send. |
| `POST` | `/send-media`               | `{ jid, mime, base64, caption? }`: an image into a chat. Groups allowed (a requested image is a reply, not a broadcast), target allowlisted to anywhere the bot already replies, capped by `image_sends_per_day` per chat.                                   |

## Behaviour worth knowing

- **A Bot never posts to a group on a timer.** `POST /send` refuses group JIDs structurally rather than through config, because the allowlists are config and fail open the day a group JID lands in one. Schedules DM.
- **Every message is recorded before any reply gating**, so the transcript is complete even for DMs the policy does not answer. History sync backfills older messages and is record-only.
- **Mentions resolve to names** before anything downstream sees the text: the bot's own ids to `bot_name` (then stripped), then the live-plus-overlay roster, then the last pushName seen for that `@lid`. The lid map and the live participant set are persisted per account so this works on the first message after a restart, and `groups.upsert` seeds a group joined after connect without a reconnect.
- **Attachments are fetched only once a reply is due.** Images and PDFs ride as file parts, text and office documents are flattened to a labelled context block, voice notes are transcribed when the gateway key is set. Caps in the env table.
- **Edits count.** A mention typed in via an edit triggers a reply once, deduped against messages already answered.
- **Shutdown drains.** SIGTERM waits for in-flight replies, flushes state and ends each socket without logging out, so a redeploy never forces a re-pair.
- **Reconnects back off with jitter**, capped at five minutes, and `/health` reports a run of identical close codes so a refused WA Web version (a persistent 405) is visible from outside.

## Layout

`src/index.ts` wires env, the accounts registry and the HTTP server. `src/account.ts` is one linked number: socket lifecycle, linking, the inbound pipeline and the proactive sends. `src/server.ts` is the API. `src/accounts.ts` is the file and its validation. The rest are pure modules with their own tests (`node --test`): `trigger`, `message-parse`, `mentions`, `live-members`, `whitelist`, `routing`, `groups`, `media-send`, `document`, `store`, `transcribe`, `wa-version`, `jid-queue`, `bounded-set`, `baileys-cache`, `report`, `invite`, `members`, `hub-client`.
