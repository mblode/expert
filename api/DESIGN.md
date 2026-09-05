# Computer API

The machine is a Linux desktop. The protocol is five agent tools
and a seat. Everything else is a client concern.

This document is the source of truth. `spec.json` is what an agent
loads. `computer.proto` names the RPCs and messages; the hub speaks
them as plain JSON over HTTP POST (see **Wire**). The TypeScript
types live in `packages/shared/src/index.ts`.

## Audiences

| Who          | Sees                                                           | Never sees                                        |
| ------------ | -------------------------------------------------------------- | ------------------------------------------------- |
| Model        | `send_message`, `computer`, `shell`, `read_file`, `write_file` | pairing, VNC URL, clipboard, trackpad, "I'm done" |
| Human client | pair, `vnc_url`, pointer, clipboard, presence, the thread      | action verbs, file paths, shell                   |

Clipboard is not a model tool. A page that copies a prompt into the
clipboard would otherwise become an injection path.

`Spec` is on `Agent` and is not a tool either: the harness calls it with the
Bot's token to learn the display and the workspace, and it is not one of the
five the model can invoke. `TOOLS` in `packages/shared` is that list, and
`spec.json` is what a model actually loads.

## Shape

```
Human ── Seat ── hub ── desk
Model ── Agent ─┘
```

Two services on one hub. One box. Many Bots, one screen per Bot.
Every screen is 1280×800.

```
service Agent {
  rpc Spec
  rpc SendMessage       // the voice: the only thing the human sees
  rpc Computer
  rpc Shell
  rpc ReadFile
  rpc WriteFile
}

service Seat {
  rpc Pair
  rpc Status
  rpc SetPresence
  rpc Pointer
  rpc Type
  rpc ClipboardGet
  rpc ClipboardSet
  rpc Occurrences       // the thread, paged
  rpc Conversations     // every place a Bot's voice speaks (owner)
  rpc ProvideSecret     // answer a secret_request: value → clipboard only
  rpc CreateBot         // provision: next free screen + minted token
  rpc DeleteBot
  rpc ExportBotTemplate // a Bot's whole setup as one portable document (owner)
  rpc ApplyBotTemplate  // write one onto a Bot on this computer (owner)
  rpc Revoke            // end a seat: the caller's own, or (owner) any
  rpc Issue             // hand a named person a seat with a role (owner, issuer)
  rpc WhatsAppAccounts  // the numbers linked to this computer (owner)
  rpc WhatsAppLink      // link by pairing code or QR, poll, unlink (owner)
  rpc WhatsAppGroups    // groups the number is in, with enabled flags (owner)
  rpc WhatsAppJoinGroup // accept an invite link (owner)
  rpc WhatsAppConfig    // read or write the account's channel settings (owner)
}
```

`POST /connectors/<id>/<path>` is the third door, beside the seat and the
agent token: a connector secret. It is how the WhatsApp bridge on this
computer, and later a webhook or Slack, reaches a Bot's Eve (see
**Connectors**).

`GET /spec` is the HTTP view of `Agent.Spec`. An agent that can fetch
JSON does not need the proto. `GET /roster` (seat) lists Bots and their
seat states; `GET /healthz` is public.

`GET /healthz` is public for two reasons, not one. It is the platform's
health check, and it is the door the clock knocks on: a computer suspends
to zero, a suspended Machine has no clock, and a request through Fly Proxy
is what starts one, so `apps/clock` wakes a box for its routines by GETting
this route and nothing else. That is why it stays credential-free and why it
carries `busy`, which says whether any Bot is at work: waking the Machine is
not enough on its own, since a routine turn makes no traffic of its own and
the platform would suspend the guest underneath it. Nothing else about the
box is readable here, and nothing here can make it do anything.

## Wire

Every RPC is `POST /computer.v1.<Service>/<Method>` with a JSON body
and `Authorization: Bearer <token>`. Responses are JSON. This is the
Connect unary shape, not Connect's error envelope: errors are the one
envelope under **Errors**. Bodies are capped at 1 MB.

CORS is `*` on every JSON response so the Vercel-hosted web app can
call the hub cross-origin. That is safe only because every call is
bearer-authenticated and nothing reads cookies.

## Screens

One shared box; each Bot owns one **screen**, a window index that is
an X display number. Primary is `:1`; forks are `:2`–`:8`. This is
Grok's shape: the machine is shared, the screen is not.

- **Agent token → Bot → screen.** The model never names a display; its
  bearer token identifies its Bot, and the hub routes to that Bot's
  screen.
- **Seat calls take an additive `display`** (absent = primary). Any
  paired seat token may view or take any screen, one human, many
  Bots. The seat FSM below runs **per screen**; `SEAT_HELD` on one
  screen says nothing about another.
- `Status` returns `screens: { bot_id, display, state, vnc_url }[]`
  beside the top-level fields (which describe the requested display),
  so a client can render a screen picker.
- **Bots are provisioned, not configured.** `Seat.CreateBot { id }`
  allocates the next free screen, mints the Bot's token (returned
  exactly once on the wire), claims the window, and persists the
  roster. `Seat.DeleteBot` frees the screen and revokes the token. A
  paired seat is the box owner; the model cannot provision.
- **A Bot that ships with the build provisions itself at boot.** Every
  eve.dev project under the guest's bots root with no roster row gets one,
  on the lowest free screen, with a minted token, exactly as `main` always
  has. Nothing is minted over an existing row and nothing is ever removed,
  so a token stays issued once and a Bot whose project is gone keeps its
  screen and its thread until a person deletes it. The inverse holds too:
  `DeleteBot` on a Bot the image still ships frees its screen only until
  the next boot.
- **A Bot's profile is the human's to edit.** `GET /roster` carries
  `profile { id, name, title, description, avatar_shape, avatar_color }`
  beside each Bot's id and screen, and `Seat.SetBotProfile { id, ... }`
  writes it back, returning the stored profile. The hub folds the profile
  into that Bot's system prompt, so it is identity rather than decoration:
  an owner's edit, not an `operator`'s, who drives the box without
  reshaping it. The request is the whole profile, `title` and `description`
  are cleared by an empty string, and the mark is two closed sets (eight
  shapes, twelve colours) rather than free text, because the file lives on
  the box at `/workspace/.bots/<id>/profile.json` where the model's
  `write_file` reaches it and the colour lands in a client's inline style.
  The read clamps the same way the write validates, for the same reason.
  A Bot that ships with the build carries `agent/profile.json` in its
  project, and the hub seeds that file once, into an empty profile, so a
  Bot introduces itself correctly the first time the roster is read. It is
  a seed and not a default: after the first boot the file on the volume is
  the human's and the Bot's, and a deploy must not undo a rename.
- Claims live on the box in `/workspace/.window-assignments.json` with
  sha256 owner hashes, written by `start-window`/`stop-window`. Window
  N serves RFB on port `5900 + N`.
- **Bots are not security boundaries.** Same box user, shared
  `/workspace`, and the X clipboard is per display but the box is one
  trust domain. Do not split trust across Bots.

## Seat

```
        request_takeover              SetPresence(false)
   AGENT ──────────────► WAITING ───────────────────► AGENT
     ▲                      │                           ▲
     │                      │ Pointer / Type / clipboard│
     │                      ▼                           │
     └──────── HUMAN ───────┘                           │
     ▲        SetPresence(false) ────────────────────────┘
     │
     └── SetPresence(true): a human takes the seat, unasked
```

| State     | `computer` / `shell` / files | Human pointer           |
| --------- | ---------------------------- | ----------------------- |
| `AGENT`   | runs                         | rejected `SEAT_HELD`    |
| `WAITING` | rejected `SEAT_HELD`         | first contact → `HUMAN` |
| `HUMAN`   | rejected `SEAT_HELD`         | runs                    |

A human never has to wait to be asked. `SetPresence({ present: true })`
takes the seat from `AGENT`; the agent's next call gets `SEAT_HELD`, which
it already handles. A batch that is already running stops at its next
action, which is reported `skipped: seat_taken`. The person watching the
machine work is the one who can see it going wrong, so grabbing the wheel
cannot require permission.

`I'm done` is `SetPresence({ present: false })`. It is not a model
tool. After it, the next `computer` call runs.

### Principals and roles

Every bearer the hub accepts is a **principal**: a `user` at a seat, a
`bot` holding an agent token, or a `service` like the WhatsApp bridge or a
control plane. One verify path checks all three, so a handler asks what
this caller may do rather than which file its credential came from.

A principal carries a **role**, and a role is a set of methods.

| Role        | Kind    | May call                                                                                             |
| ----------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `owner`     | user    | every Seat RPC, any display, no expiry                                                               |
| `operator`  | user    | `Status`, `SetPresence`, `Pointer`, `Type`, `ClipboardSet`, `ProvideSecret`, `Occurrences`, `Revoke` |
| `viewer`    | user    | `Status`, `Occurrences`, `Revoke`                                                                    |
| `guest`     | user    | the operator set minus `Occurrences`, bound to one display, always expiring, at most four hours      |
| `installer` | service | `CreateBot`, `DeleteBot`, `Revoke`, always expiring, at most ten minutes                             |
| `issuer`    | service | `Issue`, `Revoke`                                                                                    |
| `bot`       | bot     | the Agent service                                                                                    |
| `ingress`   | service | the connector door only, no RPC                                                                      |

`owner` is unrestricted inside the Seat service, which is what a paired
seat has always been: an RPC added tomorrow works for the owner the moment
it is registered. Every other role is an explicit allowlist, so the same
new RPC stays denied to them until someone lists it. That asymmetry is
deliberate: adding a method must never quietly widen a narrow role.

`installer` exists because authoring an Eve connection file is not a
seat-shaped act: `Agent.WriteFile` takes an agent token, so writing one
means `CreateBot`, write as that Bot, `DeleteBot`. The control plane used
to ask for an `owner` narrowed by `methods` to those calls, since `owner`
was the only role carrying `CreateBot`; that is a role defined by hand at
the call site, and the door it left open is the next route gated on the
role rather than the method. Read its containment honestly: a Bot token is
`shell` on the box, so an installer is one call from running code there.
What it never reaches is the owner's HTTP doors, the clipboard, WhatsApp
linking, `Issue`, or any seat but its own. It is a ten minute grant to do
one job, not a safe role, and the durable fix is a Seat RPC that writes a
connection file so no agent token is minted at all.

`Pair` still mints an owner with no subject, because whoever holds the
setup code is the owner and the hub cannot learn their name. `Issue` is
how a principal that _does_ know its users hands one of them a seat:
`Issue { role, subject, ttl_sec, display, methods, label }` returns a token
once. An owner may issue any role. An `issuer`, which is what a control
plane holds instead of the setup code, may issue only the working roles,
never `owner` and never another `issuer`. A stolen control plane can then
take the mouse on the boxes it knows, which is bad, rather than own them
forever, which is unrecoverable. The `installer` role is the sharp edge of
that claim: an issuer may hand one out, and an installer may `CreateBot`,
whose token is `shell`. So a stolen issuer reaches code execution on the
box; it still cannot mint an owner, revoke one, or keep a seat the owner
cannot see in the seat list and revoke.

A `guest` and an `installer` are refused with no `ttl_sec`: an unexpiring
one of either is a mistake rather than a choice, so the hub will not mint
it even for an owner.

A principal with a `display` is bound to that screen whatever its role:
`Status` lists only that screen, an absent `display` resolves to it, and
naming another is `UNAUTHENTICATED`. `methods` narrows a role further and
can never widen it. `Revoke {}` ends the caller's own seat, which is what
sign-out does; naming another token is an owner's call, and an issuer's for
any seat that is not an `owner` or another `issuer`, so a control plane can
replace a grant it made without holding an owner and cannot lock the human
out of their own box. `/eve/v1` (the
thread), `/roster` and the pixel stream remain owner-only, and an owner
carrying `methods` is not one of them: those doors are HTTP routes, so no
allowlist can name them, and a grant narrowed to a couple of RPCs must not
inherit the three that were never narrowed. A `guest` always expires.

Seats on disk from before this predate roles: a bare token string is an
owner that never expires, and a record whose `kind` is `owner` or `guest`
carried its role there. Both still load, and neither names a subject, so
the hub reports them as unattributed rather than inventing a person.

`request_takeover` is a `computer` action. It moves `AGENT → WAITING`
and returns a screenshot. Further `computer` calls return `SEAT_HELD`
until the human releases.

## Voice

Plain model text is a private scratchpad. The human sees exactly the
occurrences `Agent.SendMessage` writes into the Bot's thread, and
nothing else. Three kinds:

| `kind`           | Human sees                                   | Ends the turn? |
| ---------------- | -------------------------------------------- | -------------- |
| `text`           | a bubble, optional base64 PNG `images`       | no             |
| `widget`         | `prompt` and 1–6 `options`                   | **yes**        |
| `secret_request` | `prompt` and a masked field labelled `label` | **yes**        |

A turn that ended waits on the human; a second send is `CONFLICT`. The
turn re-opens when the human speaks: a message, a widget answer, or a
delivered secret. `Seat.ProvideSecret { occurrence_id, value }` puts the
value on the box clipboard and nowhere else, not the thread, not the
response, not the model's context, and clears it after two minutes if
it is still there. It works once per request.

`Seat.Occurrences { cursor?, limit?, conversation_id? }` pages a thread
oldest-first; `cursor` is the last `seq` the caller has. Without a
`conversation_id` it is the display's Bot `seat` conversation, which is
where the thread has always been and is now one conversation among the
Bot's; with one it is that conversation, below. Entries carry an additive
`conversation_id` and `author`, and the `cursor` / `next_cursor` / `seq`
contract is untouched.

There is no Seat RPC to answer a `widget` yet: a client re-opens the turn
by sending a new message through its harness. That is a known gap.

## Conversations

A **conversation** is one place the Bot's voice speaks: a record
`{ id, bot, route, participants, last_seq, created_at, updated_at }` the hub
owns. The route is where messages leave for, `{ kind: "seat" }`,
`{ kind: "whatsapp", acct, jid }`, `{ kind: "peer", bot }` or
`{ kind: "code", repo, agent }`, and a conversation is created by an inbound
on a route that already exists, by a coding session, or by an owner. There
is no create-a-route path from the model, in any phase.

Messages are append-only, `seq` monotonic per conversation, each with an
`author` (`bot`, `human` or `system`) and the same four bodies the Voice
section lists. The index is `/workspace/.computer/conversations.json` and
each log is `/workspace/.computer/conversations/<id>.jsonl`, both hub-owned
at 0600 in a 0700 directory: the model runs as `box` and cannot read or
rewrite what a bot-to-bot hop will be audited from.

**Which conversation a `send_message` lands in is the hub's answer, never
the model's.** The connector ingress resolves the inbound to a conversation
and mints a **turn token** bound to `{ conversation_id, bot, hops_left,
deadline_at }`, forwarded to Eve as `x-computer-turn` beside the hub secret.
Eve puts it on the session's auth attributes, where tool code reads it and a
prompt cannot reach it, and `send_message` hands it back on the same header.
The hub refuses a token it did not mint or one past its deadline
(`UNAUTHENTICATED`) and one presented by another Bot (`DENIED`). No turn
token is the Bot's seat thread. `send_message` grows no target: a
conversation id addresses a human's route, so letting the model name one is
the injection path the five-tool rule refuses.

The turn rules are unchanged and are now per conversation, enforced in one
place for every route, which is why a `widget` waiting on hello.expert no
longer makes the next WhatsApp reply `CONFLICT`. A `widget`'s `answer` and a
`secret_request`'s `provided` are derived on read from the message that
closed the request: the log is append-only, so a line is never rewritten.

`Seat.Conversations { display? }` lists them:
`{ id, route, participants, last_seq, updated_at }[]`, no message bodies,
`Seat.Occurrences` is still the read. Owner seat only, and contained by the
screen the seat was minted for, exactly as `Occurrences` is: a seat bound to
display N must not learn that another display's Bot has a conversation, let
alone read it.

Each Bot's `seat` conversation is seeded once, at boot, from the
`/workspace/.bots/<id>/transcript.jsonl` the hub wrote before conversations
existed, with `seq` carried through so a cursor held across the deploy still
means what it meant. It runs once, marked on the record, and it is a resume
rather than a second copy if it is interrupted. That file is then read no
more and written never again; it is not deleted, for the same reason
deleting a Bot leaves its box state alone. It is the human's record.

## Templates

A Bot reads all of this off the box itself, at the start of every turn. The
template project's `agent/instructions/profile.ts` folds in the profile, the
brief and the index of the skills (never their bodies) through the `read_file`
door it already has, which is why applying a template is writing those files
and nothing more: no RPC was added for it, and the Agent service is still the
five tools plus `Spec`. `apps/eve/lib/profile.ts` is the composer.

A **template** is everything that makes a Bot itself, as one document: its
profile, its brief, what it remembers, its skills, its routines and the
services it expects. `Seat.ExportBotTemplate` reads one off a Bot;
`Seat.ApplyBotTemplate` writes one onto a Bot. Both are owner seats only,
and both are contained by the screen the seat was minted for, like every
other by-id RPC here.

Export reads two places and apply writes one. A Bot that came with the build
keeps its brief, its skills and its schedule in its Eve project, in git; a
Bot made at runtime keeps them on the volume under
`/workspace/.bots/<id>/` (`instructions.md`, `skills.json` plus
`skills/<id>.md`, `routines.json`, `plugins.json`). Export prefers the box
where both answer, the same rule the profile follows, because after the
first boot the file is the human's. **Apply writes the box and only the
box.** `/workspace` is box-writable and the Eve projects are what the build
shipped, so a template that could write one would be a link that edits the
computer's code.

What travels is what a Bot is, not what it can reach. **No credential is in
a template**: a plugin is the address of a service and how it authenticates,
so the person installing signs in as themselves. Neither is anything naming
the computer it came from: no bot id, no hub, no paths. Memory travels as
facts without their dates, because a shared memory is something the
receiving Bot is being told rather than something that happened to it, and
it is appended to what that Bot already knows rather than written over it.

Every field is clamped on the way out **and** on the way in
(`BOT_TEMPLATE_MAX`, `parseBotTemplate` in `packages/shared`). A template
arrives from a computer this one has never met, its ids become filenames and
its strings become a system prompt, so ids are slugged here rather than
trusted, a cron `cronMatches` cannot evaluate is dropped rather than
carried, and control characters are stripped. Installing a template is
consenting to run its instructions, which is why the page that offers it
shows every section in full first.

The link is not the hub's. A computer belongs to one account and the point
of sharing a Bot is that the other person is on a different one, so the
document is copied to hello.expert, which is the only thing both accounts
can see, and the install is `CreateBot` then `ApplyBotTemplate` from the
recipient's own browser with their own seat (`docs/BOTS.md`, "Sharing a
Bot").

**A shared template is rewritten for a stranger**, and that is the difference
between a copy of your Bot and a Bot someone else can use.
`ExportBotTemplate { generic: true }` is what the share sheet asks for by
default. A working Bot is full of one person: its brief names their product,
its skills name their repository, its memory is a list of facts about them.
Published verbatim that is both useless (half the procedures reference things
the reader does not have) and a leak.

**The rewrite is the Bot's own model.** The hub POSTs the document to that
Bot's Eve (`/eve/v1/template/generic`, the same loopback secret the connector
ingress uses) and the route runs the model its `agent.ts` names. Nothing
about it is a pattern match, and that is the point: knowing that "the Done
Bear board" is this owner's product while "the week view" is anybody's
calendar is judgement, and a rule written to catch the first would mangle the
second while leaving the owner believing the document had been cleaned. It is
a route and not a session, so the rewrite is one generation with a schema on
the way out rather than a turn holding the five tools.

The hub keeps the containment, which is not the same as doing the work. It
walks its own entries and takes the rewritten text only for ids it sent, so
the model may rewrite and it may drop and it can never add; the answer goes
back through `parseBotTemplate`; and memory never survives a generic export
at all, because a fact a Bot kept about the person it works for is about that
person however it is worded.

`generic` on the response is whether the rewrite **ran**, not whether it was
asked for. A Bot whose Eve cannot answer, or whose model failed, comes back
with the verbatim document, `generic: false` and a `note` saying so: a person
who ticked the box and was handed their own name back is the failure that
field exists to prevent.

One thing a template carries and cannot yet make run: a **routine**. What
fires a routine is that Bot's own croner, compiled from
`agent/schedules/*.ts` in its Eve project, and a Bot made at runtime runs
the template project, which has none. So an installed routine is recorded,
shown, and says it is paused rather than quietly never running.

## Coding sessions

Computer use and coding are different jobs, and this computer does one of
them. A coding session is **delegated**: the hub hands a task and a GitHub
repository to a runner (Cursor's Cloud Agents API) and keeps the thread, so
a session is a conversation with a `code` route and hello.expert, the phone
and WhatsApp read it where they read everything else.

Delegated rather than run here, for reasons that are each written down
elsewhere and all point the same way. A coding harness started under the
supervisor has its own shell and never crosses `PolicyService`, Auto Review
or the seat, which makes it a door this document did not authorise. `shell`
is capped at 120 s, so a session cannot be an RPC. A worktree is not a
boundary, because the Machine is the only one there is. A running session
pins a Machine that should suspend. And a child started as `box` shares that
uid with the model's own `shell`, so a credential in its environment is
readable out of `/proc`. Every one of those costs disappears off the box.
Work that genuinely needs the box (this computer's own code and deploy, the
signed-in browser, `/workspace` state that exists nowhere else) is not this
RPC and is not yet built; `docs/plans/coding-sessions.md` says what it takes.

Two Seat RPCs, owner only and contained by the screen exactly as
`Occurrences` and `Conversations` are:

```
Seat.StartCodingSession { display?, repo, prompt, ref?, auto_create_pr?, model? }
Seat.RefreshCodingSession { conversation_id }
```

There is deliberately no list RPC: a session is a conversation, so
`Seat.Conversations` already lists them, with `repo` and `agent` on the
route. Both answer a `CodingSession`
`{ conversation_id, agent, repo, state, url, branch, pr_url, summary }`.
`state` is the agent-session vocabulary, `pending | active | awaitingInput |
complete | error | stale`, chosen to match Linear's so that reading a
session from an issue tracker later is a rename rather than a translation;
the runner's `CANCELLED` and `EXPIRED` are both `stale`, because to a person
reading the thread they are the same fact.

The thread is the record. The prompt is appended as the human's own words,
each status change as one `system` line, and nothing else: no fifth message
body, so every client that renders a conversation renders a coding session
for free. A refresh whose status has not moved appends nothing, so polling
is free and idempotency comes from the log rather than from memory the hub
could lose. `repo` must be `https://github.com/<owner>/<name>`; the hub
refuses anything else rather than passing a URL through to be guessed at.

**Not a model tool.** A session is started by a person at a seat, or later
by a connector. The five tools are the whole model surface and a sixth for
this would be the same widening the Voice section refuses; a Bot delegating
work is bot-to-bot, which is a conversation, not a new tool. Unconfigured
(no `CURSOR_API_KEY`) is `DAEMON_DOWN` on both, the way the WhatsApp RPCs
answer without a bridge. The key lives in the hub's environment and
never in an error message.

## Connectors

A Bot is reached by its owner through the seat, by the model through its
agent token, and by everything else through a **connector**: a record
`{ id, kind, bot, secret, paths? }` in the hub's `connectors.json` with its
own secret, minted once and rotated or removed on its own. The ingress
maps `POST /connectors/<id>/<rest>` with header `x-connector-secret` onto
that Bot's Eve at `/eve/v1/<kind>/<rest>`, adding the hub's loopback secret;
`paths` narrows which Eve routes the door may reach. There is no lockout
on this door, unlike `Pair`: it is public and its ids are guessable, so a
lockout would let a stranger block the real bridge; the 256-bit secret and
a constant-time compare are the defence. Bodies are capped at 12 MiB (two
bridge images as data URLs). A seat token is not a connector secret and a
connector secret opens nothing else.

A connector points **inward** and carries a credential this hub minted. A
plugin, the neighbouring word, points **outward** at a remote MCP or
OpenAPI service and carries a credential a human consented to hand over.
The credential faces the opposite way in each, so the two names never
collapse into one. `kind` names an Eve channel file (`whatsapp` finds
`apps/eve/lib/channels/whatsapp.ts`), and a channel is still what eve calls
that file: the door in front of it is the connector.

The rename landed with two compatibility aliases, because both tenants have
a `channels.json` on the volume and a deployed bridge posting the old
spelling. The ingress also answers `POST /channels/<id>/<rest>` and also
accepts `x-channel-secret`, and the store reads `channels.json` when there
is no `connectors.json`, writing only the new name. Both aliases go once
Blode and Vibey run a bridge that sends the new names.

The WhatsApp bridge is a hub-supervised process on the same Machine, one
Baileys socket per linked number. Linking is an owner's job on
hello.expert through the `WhatsApp*` Seat RPCs: `WhatsAppLink { acct,
action: "start", phone? }` creates the account's connector record
(`whatsapp-<acct>`, kind `whatsapp`, path `/eve/v1/whatsapp/message`), tells
the bridge about it, and returns a pairing code (with `phone`) or a raw QR
string (without) to render; `action: "status"` polls; `action: "unlink"`
logs the device out and removes the connector record with it. `WhatsAppConfig`
holds which groups the number serves (`group_policy: "all" | "listed"`,
`allowed_groups`), how it is triggered, who may DM it, and the image cap.
The bridge's own credentials live under the hub's user, which the model's
`shell` cannot read.

## Computer

One tool. One request. A list of actions, run in order, one display.

```
ComputerRequest {
  request_id: string        // idempotency; retry with the same id
  actions: Action[]         // 1–20, sequential
}
```

### Actions

A closed union. Eleven members. Not eleven MCP tools.

| Action             | Fields               | Notes                                                                                    |
| ------------------ | -------------------- | ---------------------------------------------------------------------------------------- |
| `screenshot`       |                      | Capture now.                                                                             |
| `click`            | `x`, `y`, `button?`  | `left` default. `right`, `middle`, `back`, `forward`.                                    |
| `double_click`     | `x`, `y`, `button?`  |                                                                                          |
| `scroll`           | `x`, `y`, `dx`, `dy` | Wheel ticks at a point, each in −20..20.                                                 |
| `keypress`         | `keys`               | Chord of 1–5, e.g. `["ctrl","c"]`.                                                       |
| `type`             | `text`               | Unicode, 1–4000 chars. Pasted via the clipboard, so it overwrites it. Not an editor API. |
| `move`             | `x`, `y`             | Pointer only.                                                                            |
| `drag`             | `path: {x,y}[]`      | 2–32 points. Down at first, up at last.                                                  |
| `wait`             | `ms`                 | 1–8000.                                                                                  |
| `zoom`             | `x`, `y`, `w`, `h`   | Region at native pixels. See coordinates.                                                |
| `request_takeover` |                      | Seat → `WAITING`. Terminal in the batch.                                                 |

No `navigate`. Chromium is an app; the address bar is pixels and keys.
No `form_input`. That is a browser product, not a desktop.

### Batch

1. Validate the whole batch first. Any action outside its limits is a
   `VALIDATION` (or `OUT_OF_BOUNDS`) error for the whole request, and
   nothing runs, so the id is free to reuse with a fixed body.
2. Run actions in order.
3. On the first failure, do not run the rest. Mark them `skipped`.
4. Return one result per requested action, same order.
5. After the batch, attach one screenshot of the display, unless the
   last _executed_ action was `screenshot` or `zoom` (those results
   already carry the image). A batch that ran nothing still gets one.
6. `request_takeover` is terminal. Anything after it is `skipped`.

```
{ kind: "ok",      duration_ms, image_b64?, media_type?, image? }
{ kind: "error",   duration_ms, code, message, reason?, phase?, retryable? }
{ kind: "denied",  rule, reason }   // a hub policy refused it before it ran
{ kind: "skipped", reason }         // prior_failed | after_takeover | after_denied | seat_taken
```

Closed on the way in, additive on the way out: a client must degrade a
result `kind` or skip `reason` it does not know to the generic case
rather than hard-fail on it.

### Images

Bytes are not a name. Every image the hub returns carries an `image`
block beside its base64, and the response's trailing screenshot carries
the same block as `screenshot` beside `screenshot_b64`.

```
image?: { id: string, width: number, height: number, source?: {x,y,w,h} }
```

`id` is a sha256 prefix of the PNG. It is content-addressed rather than
random for two reasons: a harness that has dropped the bytes out of the
transcript can still let the model refer to the image, and two equal ids
mean two identical screens, which is the cheapest possible answer to
"did my click do anything". `width` and `height` are this image's
pixels, so a full capture reports the display and a `zoom` reports its
crop. `source` is set only by `zoom`; see **Coordinates**.

The block is absent when the bytes are, and also when the PNG header
cannot be read: a screenshot must never be lost to a metadata failure.

### Focus

```
focus?: { title: string }
```

The focused window's name, as X reports it. The one thing a model
reading only pixels reliably gets wrong is which window it is in, and
the hub already reads this string every batch to build `pending_checks`,
so naming it costs no new exec and opens no new door.

It is untrusted, and the field name does not say so on its own: a page
sets its own title, so this is the page talking. The hub strips control
and format characters and caps it at 200 characters, which is what stops
a title from faking a line of transcript, and nothing in the hub ever
branches on it. This is the whole of the environment context the model
gets: no URL, no tab list, no page text. A window's name is a label the
model may read. Anything richer is the page handing the model
instructions through a side door, which is the same refusal as the
clipboard.

### Coordinates

Invariant: **every `x`,`y` is an integer pixel of the last full-display
screenshot.** Origin top-left. Display is 1280×800. Scale is 1.

`zoom` returns a crop. The next action's coordinates are still in
the full 1280×800 space, not the crop. It is the only rule that does
not punish a model for zooming. The crop's result states the rectangle
it came from in `image.source`, so the projection back is read rather
than remembered.

Never normalize to 0–999. It looks portable and is a footgun the
moment two displays or a zoom exist.

### Safety

After a batch, the response may include `pending_checks`. The agent
must not continue the same task until a human has answered.

```
pending_checks?: {
  id: string
  code: "destructive" | "credential" | "exfil"
  message: string
}[]
```

The hub emits `credential` when a password field is focused, and
`destructive` when a known confirm dialog is frontmost or a policy rule
answered `ask`. The model calls `request_takeover`. The human uses the
seat. There is no model-side acknowledge RPC, the seat _is_ the
acknowledge.

Policy is hub-side (`data/policy.json`): a rule can `allow`, `ask` or
`deny` a computer action or a shell argv pattern, or delegate to a check
command. A refusal is `denied` on the wire, which no harness can talk its
way out of. A check that fails denies.

### Idempotency

`request_id` is required. A retry with the same id returns the first
response, and a retry that overlaps the first run waits for it rather
than running again. A new id runs a new batch. A reused id with a
different body is `CONFLICT`. A batch that never started (`SEAT_HELD`,
`DAEMON_DOWN`) is not remembered. The hub keeps the last 256 ids.

## Shell and files

`shell` runs `argv` in `/workspace` (or `cwd` under it). Timeout
1–120s, default 30, enforced inside the box so the process actually
dies. Output is stdout, stderr, exit, truncated flags (200 kB each).
`request_id` is idempotent the same way `computer` is.

`read_file` / `write_file` take a path. Absolute paths must start
with `/workspace`. Relative paths resolve there. `..` after resolve
is `PATH_REJECTED`. This is a guardrail against mistakes, not a
sandbox: `shell` can reach the whole box.

These are not computer-use. They exist so the model does not have to
open an editor to change a file.

## Errors

One envelope everywhere:

```
{ "error": { "code": "SEAT_HELD", "message": "human has the seat" } }
```

| Code              | HTTP | When                                                                                   |
| ----------------- | ---- | -------------------------------------------------------------------------------------- |
| `UNAUTHENTICATED` | 401  | missing or bad bearer; bad or locked-out setup code                                    |
| `SEAT_HELD`       | 409  | caller does not own the seat                                                           |
| `OUT_OF_BOUNDS`   | 400  | coordinate outside 1280×800                                                            |
| `PATH_REJECTED`   | 400  | path escapes `/workspace`                                                              |
| `DAEMON_DOWN`     | 503  | desk exec or input is dead                                                             |
| `VALIDATION`      | 400  | bad request                                                                            |
| `CONFLICT`        | 409  | `request_id` reused with a different body; turn already ended; secret already provided |
| `DENIED`          | 403  | a shell call refused by policy                                                         |

`DAEMON_DOWN` carries `reason`, `phase` and `retryable` beside
`code`/`message`, the first-party `workspace_unavailable` shape,
restricted to what this box can tell apart. `retryable` is the client
contract: false only when no route to the box exists.

## What the phone does

`Pair` exchanges the setup code for a bearer and a `vnc_url`. Ten
wrong codes lock `Pair` for a minute.
`Status` returns `{ state, vnc_url, display, screens }`. `vnc_url`
carries a 15-minute pixel token; a still-valid one is reused across
polls so a viewer is not remounted every poll.
Seat calls take an additive `display` to pick a screen (see Screens).
`Pointer` is the trackpad: `{ type: "move", dx, dy, grab? }`,
`{ type: "click", button? }` at the current pointer, or
`{ type: "scroll", dx, dy }` in wheel notches (−20..20). It does not
take screenshot coordinates, the human is looking at the stream.
`Type` is the keyboard: unicode into the focused field, 1–4000 chars.
`ClipboardGet` / `ClipboardSet` are UTF-8 only.
`SetPresence(false)` is `I'm done`.
`CreateBot` / `DeleteBot` provision Bots (see Screens), the phone is
the box owner, so provisioning lives on the seat, never on the model.

The VNC stream is view-only at the X server. The client never sends
RFB pointer events. Input is `Seat.Pointer`/`Seat.Type` so the hub can
enforce the seat. A pixel token opens only the display it was minted for.

## Trust on the box

Two users. `box` is the desk and the model: X, Chromium, Eve, the model's
`shell`, everything the Bot works on under `/workspace`. `hub` is the hub
and the WhatsApp bridge: it owns `/workspace/.computer` (roster, seat
tokens, connector secrets, the Eve secret, Baileys credentials) at 0700.
Under one uid there is no boundary, so the hub is not `box`; when it needs
the desk it runs the command through `sudo -u box`, the one sudoers line
in the image. Bots are still not security boundaries
from each other: same `box`, shared `/workspace`.

## Version

`computer.v1`. Additive fields are fine. New actions require v2.
`GET /spec` reports `version`.

## Owner work links

`Agent.SendMessage` accepts `kind: "link"` with `destination: "computer" | "plugins" | "code"`. The hub constructs an HTTPS `/work` URL for the authenticated Bot and bound conversation and records it as an ordinary text occurrence. No model-supplied URL, Bot, conversation, or credential participates. The web checks the signed-in account and matching hub before resolving the Bot display. The link itself grants no access. `COMPUTER_PUBLIC_URL` identifies the issuing hub; `COMPUTER_WEB_URL` defaults to hello.expert.

`Seat.StartCodingSession` accepts optional `request_id`. Reusing it with the same brief reuses a persisted provider identity and result; changed input returns CONFLICT. Persisted intents live beside the roster. A provider 409 is reconciled by reading that identity. Provider error bodies never reach the model or browser. Legacy callers without request_id retain their original behavior.

## Personal assistant dispatch and recovery

The operator explicitly binds `COMPUTER_PA_ACCOUNT` and `COMPUTER_PA_OWNER_JID`; exact sender and DM destination must match the authenticated account connector. Group membership and `owner_jids` are not grants. `send_message` accepts `kind: "code"`, `repo`, and `text` only on an owner-bound turn and only for `COMPUTER_PA_REPOS`. The server derives the launch identity from that turn; model arguments cannot select a grant or another source conversation. The response includes `coding_session` and an authenticated work `url`.

PA ingress persists a receipt and obtains a durable outside-clock lease before returning 202. Its driver records the result and sends it through the account bridge with a stable delivery identity. Interrupted unknown outcomes are reported as uncertain rather than repeated. Legacy groups retain synchronous delivery. Turn tokens persist with their original deadlines; only the trusted active driver extends a lease, and stopping that driver lets it expire.

### Approved assistant configuration

`Agent.Spec` includes `runtime`, the authenticated Bot's current configuration
revision. `send_message` kind `configure` accepts `configuration` with operation
`read`, `replace` or `undo`. Mutations require the exact configured PA owner on
the server-bound turn and its current `base_revision`. `Seat.ConfigureAssistant`
exposes the same operation to owner seats, contained to their assigned screen.
The JSON wire uses ordinary arrays for `memory` and `skills`; proto wrappers
represent optional lists and are not Connect binary request shapes.

Approved revisions live in the hub-owned store. They are read at each Eve turn
boundary, including continued conversations. Instructions are bounded to 10,000
characters; memory to 50 facts of 500 characters; procedures to 20 entries and
16,000 combined markdown characters. Procedures are loaded inline within that
budget. No additional loader tool, permission grant or executable source edit
is implied. Undo activates the previous content as a new revision. It does not
undo past external actions. Configuration responses return `runtime` without
creating a message occurrence; the caller must still send its human reply.

Coding launches from the owner web breakout may include `source_conversation_id`.
The hub requires that source to belong to the selected Bot and visible screen.
The background driver sends completion only when the source route matches the
currently configured PA account and owner. `Conversations` includes each row's
Bot id. The modern WhatsApp ingress delivers the recorded `send_message` voice
when present, with the same outbound redaction as Eve; final prose is a fallback
only for a turn that made no send. This keeps the conversation and delivery from
selecting different answers.
