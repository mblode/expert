# Computer API

The machine is a Linux desktop. The protocol is five agent tools
and a seat. Everything else is a client concern.

This document is the source of truth. `spec.json` is what an agent
loads. `computer.proto` names the RPCs and messages; the hub speaks
them as plain JSON over HTTP POST (see **Wire**). The TypeScript
types live in `packages/shared/src/index.ts`.

## Audiences

| Who | Sees | Never sees |
|---|---|---|
| Model | `send_message`, `computer`, `shell`, `read_file`, `write_file` | pairing, VNC URL, clipboard, trackpad, "I'm done" |
| Human client | pair, `vnc_url`, pointer, clipboard, presence, the thread | action verbs, file paths, shell |

Clipboard is not a model tool. A page that copies a prompt into the
clipboard would otherwise become an injection path.

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
  rpc ProvideSecret     // answer a secret_request: value → clipboard only
  rpc CreateBot         // provision: next free screen + minted token
  rpc DeleteBot
}
```

`GET /spec` is the HTTP view of `Agent.Spec`. An agent that can fetch
JSON does not need the proto. `GET /roster` (seat) lists Bots and their
seat states; `GET /healthz` is public.

## Wire

Every RPC is `POST /computer.v1.<Service>/<Method>` with a JSON body
and `Authorization: Bearer <token>`. Responses are JSON. This is the
Connect unary shape, not Connect's error envelope: errors are the one
envelope under **Errors**. Bodies are capped at 1 MB.

CORS is `*` on every JSON response so the Vercel-hosted web app can
call the hub cross-origin. That is safe only because every call is
bearer-authenticated and nothing reads cookies.

## Screens

One shared box; each Bot owns one **screen** — a window index that is
an X display number. Primary is `:1`; forks are `:2`–`:8`. This is
Grok's shape: the machine is shared, the screen is not.

- **Agent token → Bot → screen.** The model never names a display; its
  bearer token identifies its Bot, and the hub routes to that Bot's
  screen.
- **Seat calls take an additive `display`** (absent = primary). Any
  paired seat token may view or take any screen — one human, many
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

| State | `computer` / `shell` / files | Human pointer |
|---|---|---|
| `AGENT` | runs | rejected `SEAT_HELD` |
| `WAITING` | rejected `SEAT_HELD` | first contact → `HUMAN` |
| `HUMAN` | rejected `SEAT_HELD` | runs |

A human never has to wait to be asked. `SetPresence({ present: true })`
takes the seat from `AGENT`; the agent's next call gets `SEAT_HELD`, which
it already handles. A batch that is already running stops at its next
action, which is reported `skipped: seat_taken`. The person watching the
machine work is the one who can see it going wrong, so grabbing the wheel
cannot require permission.

`I'm done` is `SetPresence({ present: false })`. It is not a model
tool. After it, the next `computer` call runs.

`request_takeover` is a `computer` action. It moves `AGENT → WAITING`
and returns a screenshot. Further `computer` calls return `SEAT_HELD`
until the human releases.

## Voice

Plain model text is a private scratchpad. The human sees exactly the
occurrences `Agent.SendMessage` writes into the Bot's thread, and
nothing else. Three kinds:

| `kind` | Human sees | Ends the turn? |
|---|---|---|
| `text` | a bubble, optional base64 PNG `images` | no |
| `widget` | `prompt` and 1–6 `options` | **yes** |
| `secret_request` | `prompt` and a masked field labelled `label` | **yes** |

A turn that ended waits on the human; a second send is `CONFLICT`. The
turn re-opens when the human speaks: a message, a widget answer, or a
delivered secret. `Seat.ProvideSecret { occurrence_id, value }` puts the
value on the box clipboard and nowhere else — not the thread, not the
response, not the model's context — and clears it after two minutes if
it is still there. It works once per request.

`Seat.Occurrences { cursor?, limit? }` pages the thread oldest-first;
`cursor` is the last `seq` the caller has. The thread persists on the
box at `/workspace/.bots/<id>/transcript.jsonl`.

There is no Seat RPC to answer a `widget` yet: a client re-opens the turn
by sending a new message through its harness. That is a known gap.

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

| Action | Fields | Notes |
|---|---|---|
| `screenshot` | | Capture now. |
| `click` | `x`, `y`, `button?` | `left` default. `right`, `middle`, `back`, `forward`. |
| `double_click` | `x`, `y`, `button?` | |
| `scroll` | `x`, `y`, `dx`, `dy` | Wheel ticks at a point, each in −20..20. |
| `keypress` | `keys` | Chord of 1–5, e.g. `["ctrl","c"]`. |
| `type` | `text` | Unicode, 1–4000 chars. Pasted via the clipboard, so it overwrites it. Not an editor API. |
| `move` | `x`, `y` | Pointer only. |
| `drag` | `path: {x,y}[]` | 2–32 points. Down at first, up at last. |
| `wait` | `ms` | 1–8000. |
| `zoom` | `x`, `y`, `w`, `h` | Region at native pixels. See coordinates. |
| `request_takeover` | | Seat → `WAITING`. Terminal in the batch. |

No `navigate`. Chromium is an app; the address bar is pixels and keys.
No `form_input`. That is a browser product, not a desktop.

### Batch

1. Validate the whole batch first. Any action outside its limits is a
   `VALIDATION` (or `OUT_OF_BOUNDS`) error for the whole request, and
   nothing runs — so the id is free to reuse with a fixed body.
2. Run actions in order.
3. On the first failure, do not run the rest. Mark them `skipped`.
4. Return one result per requested action, same order.
5. After the batch, attach one screenshot of the display, unless the
   last *executed* action was `screenshot` or `zoom` (those results
   already carry the image). A batch that ran nothing still gets one.
6. `request_takeover` is terminal. Anything after it is `skipped`.

```
{ kind: "ok",      duration_ms, image_b64?, media_type? }
{ kind: "error",   duration_ms, code, message, reason?, phase?, retryable? }
{ kind: "denied",  rule, reason }   // a hub policy refused it before it ran
{ kind: "skipped", reason }         // prior_failed | after_takeover | after_denied | seat_taken
```

Closed on the way in, additive on the way out: a client must degrade a
result `kind` or skip `reason` it does not know to the generic case
rather than hard-fail on it.

### Coordinates

Invariant: **every `x`,`y` is an integer pixel of the last full-display
screenshot.** Origin top-left. Display is 1280×800. Scale is 1.

`zoom` returns a crop. The next action's coordinates are still in
the full 1280×800 space, not the crop. It is the only rule that does
not punish a model for zooming.

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
seat. There is no model-side acknowledge RPC — the seat *is* the
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

| Code | HTTP | When |
|---|---|---|
| `UNAUTHENTICATED` | 401 | missing or bad bearer; bad or locked-out setup code |
| `SEAT_HELD` | 409 | caller does not own the seat |
| `OUT_OF_BOUNDS` | 400 | coordinate outside 1280×800 |
| `PATH_REJECTED` | 400 | path escapes `/workspace` |
| `DAEMON_DOWN` | 503 | desk exec or input is dead |
| `VALIDATION` | 400 | bad request |
| `CONFLICT` | 409 | `request_id` reused with a different body; turn already ended; secret already provided |
| `DENIED` | 403 | a shell call refused by policy |

`DAEMON_DOWN` carries `reason`, `phase` and `retryable` beside
`code`/`message` — the first-party `workspace_unavailable` shape,
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
take screenshot coordinates — the human is looking at the stream.
`Type` is the keyboard: unicode into the focused field, 1–4000 chars.
`ClipboardGet` / `ClipboardSet` are UTF-8 only.
`SetPresence(false)` is `I'm done`.
`CreateBot` / `DeleteBot` provision Bots (see Screens) — the phone is
the box owner, so provisioning lives on the seat, never on the model.

The VNC stream is view-only at the X server. The client never sends
RFB pointer events. Input is `Seat.Pointer`/`Seat.Type` so the hub can
enforce the seat. A pixel token opens only the display it was minted for.

## Version

`computer.v1`. Additive fields are fine. New actions require v2.
`GET /spec` reports `version`.
