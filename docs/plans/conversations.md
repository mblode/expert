# Conversations: one record for the model's voice

Plan date: 2026-09-03. Companion to [`../WHATSAPP-PARITY.md`](../WHATSAPP-PARITY.md) (Phase 3 of that plan assumes this one) and [`../AUDIT.md`](../AUDIT.md) (open finding P1 #4 is the reason this is worth doing at all). Nothing here is written yet; this document is the order of work.

## Context

The model has one tool for talking to people, `send_message`, and the picture is not the one the contract describes. There are two exits and one dead end.

**Exit one, Eve's session stream.** `apps/web/components/chat-pane.tsx` renders it with `useEveAgent` over the hub's `/eve/v1` proxy, and `apps/ios/Computer/Models/EveClient.swift` speaks the same protocol through the same proxy into the reducer in `AgentTranscript.swift`. This is what a human on hello.expert actually reads, and it is raw assistant text.

**Exit two, the WhatsApp reply.** The bridge POSTs to `/channels/<id>/message`, the hub forwards to the Bot's Eve (`apps/hub/src/handler/channels.ts`), and the Eve channel runs the turn, drains the event stream and returns `{ reply }` in the response body (`apps/eve/lib/channels/whatsapp.ts`). The hub cannot tell that turn happened: the Bot token identifies the Bot, not the turn.

**The dead end, the occurrence log.** `Agent.SendMessage` calls `VoiceService.send` (`apps/hub/src/service/voice.ts`), which appends to an in-memory log capped at 2000 entries and write-behinds a JSONL line to `/workspace/.bots/<id>/transcript.jsonl` through `BotState.appendOccurrence` (`apps/hub/src/service/state.ts`). `Seat.Occurrences` pages it back (`apps/hub/src/handler/seat.ts`). **Nothing calls it.** A repo-wide grep for `Occurrences` finds the proto, the generated code, the spec, the handler and two hub tests, and no client on either surface. `AUDIT.md` P1 #4 says the same thing and asks for a decision. So a `send_message` during a WhatsApp turn lands in a log with no reader, as if a human on hello.expert had been spoken to, and the human on hello.expert would not see it either.

Two consequences worth being blunt about, because they set the scope.

First, **exit one contradicts the written contract.** `api/DESIGN.md` says "Plain model text is a private scratchpad. The human sees exactly the occurrences `Agent.SendMessage` writes into the Bot's thread, and nothing else." `api/RESEARCH.md` is stronger: "Delete that gate and the scratchpad leaks into the chat, a different product." The gate was never wired up on the web or on iOS, so the product currently ships the leak. Collapsing the exits therefore forces a question this plan does not get to dodge: does Eve's stream stay a human-facing surface, or does it become the private scratchpad the contract says it is, with `send_message` as the only thing rendered? This plan builds the object that makes that answerable and deliberately does not answer it (Out of scope).

Second, **a dead-end writer is cheap to repoint.** The migration risk everyone assumes is here is not: there is no client cursor to preserve compatibility with, no polling loop to keep serving, and no UI to re-render. What is real is the two Fly volumes holding `transcript.jsonl`, which is a file to import once, not a live contract to hold.

Adding iOS as a surface today means adding a fourth path. Adding a second Bot that can talk to the first means inventing one from scratch.

The intended outcome: a **conversation** is a first-class hub object with participants, an ordered message log and a route. `send_message` appends to the conversation the current turn belongs to. Transports deliver from it. iOS becomes a subscriber plus a push transport rather than new plumbing, and two Bots talking to each other is a conversation whose participants are two Bots, under a hop budget, a deadline, a fence and an audit trail.

## Approach

### The data model

Three records. The first two are the arguable ones.

```ts
// packages/shared/src/index.ts
interface Conversation {
  id: string; // conv_<base64url>
  bot: string; // whose voice speaks here
  route: Route; // where messages leave for
  participants: Participant[];
  last_seq: number; // mirrors the log tail, so a list needs no file read
  created_at: string;
  updated_at: string;
}

type Route =
  | { kind: "seat" } // the Bot's thread on hello.expert / iOS
  | { kind: "whatsapp"; acct: string; jid: string } // one WhatsApp chat
  | { kind: "peer"; bot: string }; // bot-to-bot, phase 3

type Participant =
  | { kind: "bot"; bot: string }
  | { kind: "human"; ref: string; display_name?: string }; // seat subject, or a WA jid

interface Message {
  id: string; // the existing `occ_<...>` shape, unchanged
  conversation_id: string;
  seq: number; // per conversation, monotonic, survives restart
  at: number;
  author: Author;
  body: MessageBody; // exactly today's Occurrence bodies
  turn_id?: string; // set for anything a turn produced
}

// `system` carries hop notices and route failures.
type Author = { kind: "bot"; bot: string } | { kind: "human"; ref: string } | { kind: "system" };
```

`MessageBody` is the existing `Occurrence` union with `id`, `seq` and `at` lifted out: `human`, `text`, `widget`, `secret_request`. Not one new kind. The turn rules stay exactly where they are (`widget` and `secret_request` end the turn, a second send is `CONFLICT`), and they become per conversation instead of per Bot, which is the actual bug fix hiding in this work: today a `widget` on hello.expert makes the next WhatsApp turn's `send_message` fail with `CONFLICT`, because one Bot has one `turnEnded` flag.

Storage is split by shape, because the two halves have different ones.

| Half                     | Where                                                               | Why                                                                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Index (`Conversation[]`) | `/workspace/.computer/conversations.json`, 0600, hub uid            | Bounded, a handful of records, identical lifecycle to `channels.json`. Reuses `readTokenFile` / `writeTokenFile` from `apps/hub/src/service/provision.ts` verbatim: atomic rename, and a file that will not read is an error rather than "empty". |
| Log (`Message[]`)        | `/workspace/.computer/conversations/<conv_id>.jsonl`, 0600, hub uid | Append-only and unbounded. Same JSONL shape and same torn-last-line tolerance as `BotState.loadTranscript` today. One file per conversation so a chatty WhatsApp group cannot slow an append to the seat thread.                                  |

Note the placement: **under `/workspace/.computer`, not `/workspace/.bots`.** That is a change from today and it is deliberate (Key decisions, "Where conversations live").

### The turn token, which is the whole trick

The hub has to know which conversation a `send_message` belongs to, and it must learn that without the model being able to say. The mechanism:

1. The channel ingress (`apps/hub/src/handler/channels.ts`) resolves the inbound to a conversation (creating it on first sight of a route) and mints a **turn token**: an opaque id the hub holds, bound to `{ conversation_id, bot, hops_left, deadline_at }`, expiring with the turn.
2. It rides to Eve in the forwarded request as a header, `x-computer-turn`, beside the existing `x-computer-eve-secret`.
3. The Eve channel reads it off `req.headers` and puts it on the session's auth attributes, next to the `groupJid` / `via` / `acct` it already sets (`apps/eve/lib/channels/whatsapp.ts`).
4. `apps/eve/lib/tools/send_message.ts` reads `ctx.session.auth.current?.attributes.turn` and `apps/eve/lib/hub.ts` sends it back as the same header on `Agent.SendMessage`.
5. The hub verifies the token is one it minted, is bound to the calling Bot, and has not expired, then appends to that conversation.

**No turn token means the Bot's `seat` conversation**, which is byte-for-byte today's behaviour, so the seat surface and every existing test keep working with no Eve-side change at all.

Two things fall out of this that are worth naming. The token is never in the model's context: eve's own docs are explicit that tool code reads `ctx.session.auth.current` and that a prompt asking for another tenant cannot change it (`node_modules/eve/docs/patterns/multi-tenant-auth.md`). And the token is the natural home for the hop budget and deadline, so the bot-to-bot guards need no second mechanism.

This object is the same object as the per-inbound **reply capability** that `WHATSAPP-PARITY.md` Phase 3 proposes for async WhatsApp delivery (`{ jid, message_id, expires_at }` signed with the channel secret). Build one, not two. This plan builds the hub-side half; Phase 3 adds the `jid` binding and the bridge's acceptance of it.

### The RPC shape

Additive only. No new Agent RPC, no new model tool.

| RPC                  | Change                                                                                                                                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Agent.SendMessage`  | Body unchanged. Response gains `conversation_id`. Reads the `x-computer-turn` header. In phase 3, one optional body field `to`, a **Bot id** (never a conversation id), accepted only when the target is in the caller's allowlist. |
| `Seat.Occurrences`   | Additive optional `conversation_id`; absent resolves to the display's Bot `seat` conversation, which is today's behaviour. Entries gain `conversation_id` and `author`. The `cursor` / `next_cursor` / `seq` contract is untouched. |
| `Seat.Conversations` | New, owner only. `{ display? }` returns `{ id, route, participants, last_seq, updated_at }[]`. This is the picker iOS needs and the audit view for bot-to-bot hops.                                                                 |

`Seat.Occurrences` stays the read side rather than being replaced by a `Seat.Messages`. It already owns the paging contract, the proto message, the spec entry and the cursor semantics; nothing reads it, so re-pointing it costs nothing; and a second read RPC is exactly the "do not keep both" the audit warns against.

### Tracer bullet

**One WhatsApp turn's reply is served out of a conversation, end to end, with nothing else changed.**

- `ConversationStore`: the index JSON plus one append-only JSONL log, hub-owned, with the restore-then-write discipline `VoiceService.restore` already has.
- One conversation auto-created on the first inbound from a given `{ acct, jid }`, participants `[{ bot: "main" }, { human: <sender jid> }]`.
- The ingress mints a turn token bound to it; the Eve WhatsApp channel carries it; `send_message` returns it; `Agent.SendMessage` appends there instead of to the seat log.
- The channel's `{ reply }` is still built by `drainStream` and still returned synchronously. Unchanged.
- `Seat.Occurrences { conversation_id }` returns the turn's messages with `author.kind === "bot"`.

That proves the four things everything else rests on: turn binding without a model-visible target, hub-owned append-only storage, route-scoped conversations, and the read RPC as a view.

It deliberately leaves out: the `transcript.jsonl` import, bot-to-bot in any form, the `to` field, iOS push, any change to `apps/web` or `apps/ios`, any change to `apps/whatsapp-bridge`, async delivery, and `AnswerWidget`. If the tracer bullet does not land clean, the design is wrong and none of the rest should be written.

### Staging after the tracer

**Phase 2, the record becomes complete.** `transcript.jsonl` imported once at boot into each Bot's `seat` conversation with `seq` preserved; `VoiceService` reduced to the turn FSM over a conversation; per-conversation turn state, which fixes the cross-surface `CONFLICT`; `Seat.Conversations`; contract files updated together. Done when a hub restart on a real Fly volume shows the same `Seat.Occurrences` page, at the same seq numbers, as before the deploy.

**Phase 3, bot-to-bot, gated on a second Bot existing.** Every deployment today provisions exactly one Bot (`main`, from `ProvisionService.start`). The design below is load-bearing now because it is what makes the data model correct; the code should not be written until there is a second Bot with a real job, and this plan says so rather than pretending otherwise.

The shape when it lands:

- **Allowlist.** `peers: string[]` on the roster record in `bots.json`, absent means empty, edited by `npm run bot`, never by the model. A `to` naming a Bot outside it is `DENIED` before anything runs. Default empty means the tool is unchanged for every Bot that exists.
- **Hop budget and deadline.** Minted on the human turn's token (`hops_left: 3`, `deadline_at: now + the ingress timeout`), decremented and re-minted for the downstream turn, refused at zero and after the deadline. Hub-side, so no prompt can talk past it, the same reason policy refusals are `denied` on the wire rather than a prompt rule.
- **Fence.** The receiving Eve wraps peer text in `<untrusted_context>` and escapes the terminator, using `neutraliseFence` from `apps/eve/lib/channels/whatsapp.ts` promoted to `apps/eve/lib/fence.ts` and generalised over the tag. `DESIGN.md` says Bots are not security boundaries, and that is precisely why the fence is needed: Bot B's text is downstream of whatever a WhatsApp member typed at Bot B, and a peer must not be a laundering path for input that arrived fenced.
- **Audit.** Every hop is a `Message` in the peer conversation with `author: { kind: "bot", bot }` and the `turn_id`, in a file the model cannot write, plus a `system` message mirrored into the originating conversation so the human watching that surface sees "main asked night to X". A side channel invisible on the surface the human is looking at is the failure mode to design against.
- **Read-only, and the halt is on the main chat.** A `peer` conversation never gets a `human` participant and never accepts a human-authored append; the hub refuses one on the route kind, in code rather than in config, for the same reason the bridge's `handleSend` refuses a group JID structurally. The human's input stays on the `seat` conversation, which already has a transport, an auth path and a working input, and which the mirroring rule above already feeds.

  The invariant that falls out is worth stating on its own, because it is what makes read-only safe rather than merely simpler: **visibility flows out of the peer conversation into the originating one, control flows from the originating one into the peer exchange, and neither crosses the other way.** One surface answers "what did a human tell this Bot", instead of two surfaces each holding half the answer.

  Read-only without a halt is the failure this is one step away from, and it is worth being precise about why. Watching two Bots negotiate with no way to stop them is not oversight, it is spectating: the exchange ends when the hop budget runs out, which is a decision the design made in advance rather than one the human makes now. So the halt is the other half of this bullet, not a later refinement. It belongs on the `seat` conversation, it revokes the turn token the exchange is running under (`service/turns.ts` already owns mint, verify and expire; this adds revoke), and the next hop fails verification the same way an expired one does. No new mechanism, no prompt-level request to stop, and nothing the receiving Bot can decline.

## Key decisions

**The WhatsApp synchronous reply survives, and stays the default.** The bridge blocks on `{ reply }` (`apps/whatsapp-bridge/src/hub-client.ts`) and retries a timeout or a 5xx up to three times; on final failure it sends a graceful note (`sendAgentReply` in `apps/whatsapp-bridge/src/account.ts`). Flipping to push-only means three things at once: `handleSend` in `apps/whatsapp-bridge/src/server.ts` refuses group JIDs _structurally_, on purpose, as the backstop for never-post-to-a-group, so async group delivery needs the signed reply capability from parity Phase 3 before it can exist at all; the existing retry loop would double-send without an idempotency key on every message rather than just the digest; and the typing indicator and graceful-failure UX are built around a call that returns. A conversation model does not require it: the conversation is the _record_, delivery is per route, and a route may pull (the response body) or push (`POST /send`). So the hub becomes the record while the bridge keeps its contract unchanged. Cost, stated plainly: interim sends ("on it, checking") still do not reach WhatsApp until the reply capability lands, and a turn slower than `agentTimeoutMs` still fails as it does today. Rejected alternative, transport-subscribes-and-pushes: correct destination, wrong order, and it is a bridge rewrite in front of a hub change.

**Conversations live in the hub's own files, split index from log, and not in SQLite.** The index is bounded records with the same lifecycle as `channels.json`, so it gets the `readTokenFile` / `writeTokenFile` discipline from `provision.ts`, whose whole point is that a file of records that will not parse is an error rather than an empty list. The log is append-heavy and unbounded, so it stays JSONL, which is what `transcript.jsonl` already is and for the same reason. Rejected: one JSON file for both, because `writeTokenFile` rewrites the whole file per append. Rejected: `node:sqlite`, which is available on this repo's pinned Node 24 (`engines: "24.x"`) and experimental on 22. It buys query, and nothing in this plan queries; it costs a schema, a migration off two live volumes, and a persistence story in a hub that currently has zero runtime dependencies. The trigger to revisit is named rather than left implicit: parity Phase 3 wants FTS5 for `session_search` over the same corpus, so do it once, for both, with a one-shot JSONL importer.

**The log moves under `/workspace/.computer`, hub uid, 0700.** Today `transcript.jsonl` is at `/workspace/.bots/<id>/`, written through the desk as `box`, which is the same uid the model's `shell` and `write_file` run as. `AUDIT.md` P1 #9 is exactly this: any Bot can rewrite any Bot's transcript, and `VoiceService.restore` trusts every line including `turnEnded`. That is survivable for a decorative log and not survivable for the audit trail of a bot-to-bot hop. Moving it to the hub's directory closes it with the mechanism already in the image (`AGENTS.md`: `/workspace/.computer` is hub-owned at 0700 and the model's `shell` cannot read it). Cost: the model loses the ability to `read_file` its own transcript, which is a feature, and `Occurrence` provenance stops being a thing an agent can forge. Rejected: validating lines on load, which was the audit's minimum bar; it stops malformed lines, not authored ones.

**The model's tool surface does not widen, and `send_message` grows no target in the surfaces that exist today.** The conversation is resolved by the hub from the turn token, which arrives on a header the model never sees and cannot mint. `api/DESIGN.md` refuses to widen the five tools because a tool is reach: clipboard read, a VNC URL and provisioning each hand the model something a page it is looking at could talk it into using. A conversation the hub already bound the turn to is not new reach; it is the same `send_message`, correctly addressed. The one future widening, the phase 3 `to`, stays inside the rule for a specific reason worth arguing with: it names a Bot from a list an owner wrote in `bots.json`, defaults to empty, and reaches only another Bot on the same box, which `DESIGN.md` already declares is not a trust boundary ("same box user, shared `/workspace`"). The guards on it are about token cost, loops and attribution, not confinement. Rejected: a sixth tool, which is a strictly worse version of the same widening plus a new name in `TOOLS`. Rejected: letting the model name a `conversation_id`, which is the injection path, since a conversation id addresses a human's route.

**The occurrence log is the seed of the conversation store, and `Seat.Occurrences` becomes its read view.** The question is usually put as "replaced, or a view", and the code makes it a smaller question than that: the log is a dead-end writer with the right shape and no readers, so repointing it is a change to where the append goes, not a migration of a live contract. Keep the writer (`VoiceService.send`), keep the JSONL record, keep `Seat.Occurrences` with its path, its `cursor` / `next_cursor` / `seq` semantics and its proto message, and add an optional `conversation_id`. Adding a `Seat.Messages` beside it would create the second reader the audit explicitly warns against, for a first reader that does not exist.

The only real migration is data, not clients: `transcript.jsonl` is live on two Fly volumes and it is the only copy. One-shot import into each Bot's `seat` conversation at boot, `seq` preserved, guarded by a marker file so it runs once, source file left in place and never written again. `seq` preservation is not cosmetic even with no client today: `VoiceService.restore` documents that a cursor held across a restart has to keep meaning what it meant, and the first real client will hold one. Leaving the source untouched follows `ProvisionService.remove`, which refuses to delete a Bot's box state because it is the human's record.

Rejected: deleting the voice subsystem and standardising on Eve's stream, which is the audit's other option. The stream cannot serve a push subscriber, because it is a live tail that never emits `done` (the reason `drainStream` breaks on `turn.completed` rather than waiting) and it has no durable cursor; and choosing it would settle the scratchpad-contract question by default rather than by decision. Rejected: starting the store empty and letting the old file rot, which throws away the only record of what these two computers have said.

## Files to modify

**Contract, changed together or not at all.** `api/DESIGN.md` (a Conversations section beside Voice and Channels; the Voice section says where messages live now), `api/spec.json` (unchanged for phase 1 and 2, since the tool body does not change; the phase 3 `to` field lands here), `api/computer.proto` (the one proto file, generated into `packages/proto/gen`), then `npm run proto:gen` and commit `packages/proto/gen`. `packages/shared/src/index.ts` gains `Conversation`, `Route`, `Participant`, `Message`, `Author` and a `CONVERSATION_ROUTE_KINDS` const in the style of `OCCURRENCE_KINDS`.

**Hub service, where the rules go.** New `apps/hub/src/service/conversations.ts` (registry over a store, mirroring `service/channels.ts` for the index half and `BotState` for the log half) and `apps/hub/src/service/turns.ts` (mint, verify, expire; hop budget and deadline). `service/voice.ts` keeps the turn FSM and delegates the log. `service/provision.ts` gains store wiring, the `seat` conversation on `create`, and the one-shot import in `mountState`. `service/bots.ts` mounts the store per Bot.

**Hub handler, where HTTP goes.** `handler/agent.ts` reads `x-computer-turn`. `handler/seat.ts` gains `conversation_id` on `Occurrences` and the new `Conversations` RPC. `handler/channels.ts` resolves the route to a conversation and mints the turn token. `handler/router.ts` only if `RpcContext` needs a `turn` field, which it will.

**Eve, the thin half.** `lib/hub.ts` carries the header. `lib/tools/send_message.ts` reads it off `ctx.session.auth.current`. `lib/channels/whatsapp.ts` puts it on the session's auth attributes beside `groupJid`. Phase 3 adds `lib/fence.ts`, promoted from `neutraliseFence`.

**Tests.** New `apps/hub/test/conversations.test.ts` and `apps/hub/test/turns.test.ts`. Extended: `test/voice.test.ts` (turn state is per conversation), `test/channels.test.ts` (the ingress mints and binds), `test/state.test.ts` (the import preserves seq), `test/http.test.ts` (the additive `Occurrences` field). `apps/eve/lib/channels/whatsapp.test.ts` for the header round trip.

**Nothing in** `apps/whatsapp-bridge`, `apps/web`, `apps/ios`, `apps/desk`, `deploy/`, or `fly*.toml`.

## Out of scope

- **Any change to the WhatsApp bridge.** Its contract with the hub is one POST and one `{ reply }`. Touching it is the difference between a hub change and a two-repo change, and the async delivery it would need is parity Phase 3's reply capability, which should land once.
- **Rendering conversations in `apps/web` or `apps/ios`, and the scratchpad-contract question behind it.** Whether Eve's session stream stays a human-facing surface or goes back to being the private scratchpad `api/DESIGN.md` and `api/RESEARCH.md` describe is a product decision with a UI rewrite attached, and burying it inside a hub change is how it gets taken by accident. This plan's obligation is narrower and firm: make the conversation the durable record so the question is answerable, and do not create a _third_ representation while doing it.
- **`AnswerWidget`.** `api/DESIGN.md` already calls the missing RPC a known gap, and the AX audit calls the resulting `CONFLICT` a blocker. Conversations make it cheaper to add later (turn state stops being per Bot) and do not require it. It arrives with whichever client decides to render a widget.
- **iOS push.** The requirement is that push _becomes_ a subscriber, and this plan delivers what makes that true: a durable, seq-ordered, per-route record and a listing RPC. APNs credentials, a device registry and delivery retry are a transport, and no part of the conversation model constrains them.
- **Deleting `transcript.jsonl`, or the `/workspace/.bots/<id>` directory.** It is live on two Fly volumes and it is the only copy. Import from it, stop writing to it, leave it.
- **Memory, `profile.json` and `BotState.memory()`.** Parity Phase 3 already owns their fate. They share a directory with the transcript and nothing else.
- **A conversation between a Bot and a human on a route the owner did not configure.** Conversations are created by an inbound on an existing route or by an owner. There is no create-a-route path from the model, in any phase.

## Verification

| Command                                                                                               | Expected                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run check` from the repo root                                                                    | Passes: typecheck on seven workspaces, layer lint, `ultracite check`, knip, the hub suite, `proto:check`. This is what CI runs.                                                                            |
| `npm run proto:check`                                                                                 | `proto:check ok`, so `packages/proto/gen` matches `api/computer.proto` and is committed.                                                                                                                   |
| `npx vitest run test/conversations.test.ts test/turns.test.ts --reporter=dot` from `apps/hub`         | Green: a conversation is created once per route, a second inbound reuses it; an unminted, an expired and a wrong-Bot turn token are each refused; appends are ordered and `last_seq` matches the log tail. |
| `npx vitest run test/voice.test.ts --reporter=dot` from `apps/hub`                                    | Green, including a new case: a `widget` on the `seat` conversation does not make a `send_message` on a WhatsApp conversation return `CONFLICT`.                                                            |
| `npm run up`, then POST a message to `/channels/<id>/message` with the channel secret                 | HTTP 200 with `{ "reply": "..." }`, the same shape the bridge parses today.                                                                                                                                |
| `Seat.Occurrences { conversation_id }` for that conversation, with an owner seat token                | The turn's messages, oldest first, each with `author.kind === "bot"` and the reply text as the last one.                                                                                                   |
| `Seat.Occurrences {}` with no `conversation_id`                                                       | The `seat` conversation, unchanged in shape from today.                                                                                                                                                    |
| `read_file /workspace/.computer/conversations/<id>.jsonl` as the Bot                                  | Refused. The log is hub-owned at 0700 and the model runs as `box`, the same guarantee the parity plan asserts for the Baileys creds.                                                                       |
| Restart the hub with an existing `/workspace/.bots/<id>/transcript.jsonl`, then `Seat.Occurrences {}` | The same entries at the same `seq` values as before the restart, and a second restart imports nothing (the marker file).                                                                                   |
| `wc -l /workspace/.bots/<id>/transcript.jsonl` before and after a turn, post-migration                | Unchanged. The file is read once and never written again.                                                                                                                                                  |
