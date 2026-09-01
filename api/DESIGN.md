# Computer API

The machine is a Linux desktop. The protocol is four agent tools
and a seat. Everything else is an adapter or a client concern.

This document is the source of truth. `spec.json` is what an agent
loads. `computer.proto` is what the hub implements.

## Audiences

| Who | Sees | Never sees |
|---|---|---|
| Model | `computer`, `shell`, `read_file`, `write_file` | pairing, VNC URL, clipboard, trackpad, "I'm done" |
| iPhone | pair, `vncUrl`, pointer, clipboard, presence | action verbs, file paths, shell |
| Hub adapter | maps OpenAI / Claude / Gemini calls onto the four tools | new verbs |

Clipboard is not a model tool. A page that copies a prompt into the
clipboard would otherwise become an injection path.

## Shape

```
iPhone ── Seat ── hub ── desk
Model  ── Agent ─┘
```

Two ConnectRPC services on one hub. One box. Many Bots, one screen
per Bot. Every screen is 1280×800.

```
service Agent {
  rpc Spec
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
  rpc CreateBot         // provision: next free screen + minted token
  rpc DeleteBot
}
```

`GET /spec` is the HTTP view of `Agent.Spec`. An agent that can fetch
JSON does not need the proto.

## Screens

One shared box; each Bot owns one **screen** — a window index that is
an X display number. Primary is `:1`; forks are `:2`–`:8`. This is
Grok's shape: the machine is shared, the screen is not.

- **Agent token → Bot → screen.** The model never names a display; its
  bearer token identifies its Bot, and the hub routes to that Bot's
  screen. Agent messages are unchanged.
- **Seat calls take an additive `display`** (absent = primary). Any
  paired seat token may view or take any screen — one human, many
  Bots. The seat FSM below runs **per screen**; `SEAT_HELD` on one
  screen says nothing about another.
- `Status` returns `screens: { bot_id, display, state, vnc_url }[]`
  beside the top-level fields (which describe the requested display),
  so a phone can render a screen picker.
- **Bots are provisioned, not configured.** `Seat.CreateBot { id }`
  allocates the next free screen, mints the Bot's token (returned
  exactly once), claims the window, and persists the roster.
  `Seat.DeleteBot` frees the screen and revokes the token. A paired
  seat is the box owner; the model cannot provision.
- Claims live on the box in `~/.window-assignments.json` with sha256
  owner hashes, written by `start-window`/`stop-window`. Window N
  serves RFB on port `5900 + N`.
- **Bots are not security boundaries.** Same box user, shared
  `/workspace`, and the X clipboard is per display but the box is one
  trust domain. Do not split trust across Bots.

## Seat

```
        request_takeover              SetPresence(false)
   AGENT ──────────────► WAITING ───────────────────► AGENT
     ▲                      │                           ▲
     │                      │ Pair / pointer / clipboard│
     │                      ▼                           │
     └──────── HUMAN ───────┘                           │
     ▲        SetPresence(false) ────────────────────────┘
     │
     └── SetPresence(true): a human takes the seat, unasked
```

| State | `computer` | Human pointer |
|---|---|---|
| `AGENT` | runs | rejected `SEAT_HELD` |
| `WAITING` | rejected `SEAT_HELD` | first contact → `HUMAN` |
| `HUMAN` | rejected `SEAT_HELD` | runs |

A human never has to wait to be asked. `SetPresence({ present: true })`
takes the seat from `AGENT`; the agent's next call gets `SEAT_HELD`, which
it already handles. The person watching the machine work is the one who
can see it going wrong, so grabbing the wheel cannot require permission.

`I'm done` is `SetPresence({ present: false })`. It is not a model
tool. After it, the next `computer` call runs.

`request_takeover` is a `computer` action. It moves `AGENT → WAITING`
and returns a screenshot. Further `computer` calls return `SEAT_HELD`
until the human releases.

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
| `scroll` | `x`, `y`, `dx`, `dy` | Wheel ticks at a point. |
| `keypress` | `keys` | Chord, e.g. `["ctrl","c"]`. |
| `type` | `text` | Unicode. Not an editor API. |
| `move` | `x`, `y` | Pointer only. |
| `drag` | `path: {x,y}[]` | ≥2 points. Down at first, up at last. |
| `wait` | `ms` | Cap 8000. |
| `zoom` | `x`, `y`, `w`, `h` | Region at native pixels. See coordinates. |
| `request_takeover` | | Seat → `WAITING`. Terminal in the batch. |

No `navigate`. Chromium is an app; the address bar is pixels and keys.
No `form_input`. That is a browser product, not a desktop.

### Batch

Claude's rule, stated once:

1. Run actions in order.
2. On the first failure, do not run the rest. Mark them `SKIPPED`.
3. Return one result per requested action, same order.
4. After the batch, attach one screenshot of the display, unless the
   last *executed* action was `screenshot` or `zoom` (those results
   already carry the image).
5. `request_takeover` is terminal. Anything after it is `SKIPPED`.

```
{ kind: "ok",      duration_ms }
{ kind: "error",   duration_ms, code, message }
{ kind: "skipped", reason }          // "prior_failed" | "after_takeover"
```

`zoom` and `screenshot` results also carry `image_b64` and `media_type`.

### Coordinates

Invariant: **every `x`,`y` is a pixel of the last full-display
screenshot.** Origin top-left. Display is 1280×800. Scale is 1.

`zoom` returns a crop. The next action's coordinates are still in
the full 1280×800 space, not the crop. This is Claude's 2026 rule.
It is the only rule that does not punish a model for zooming.

Never normalize to 0–999. Gemini's scheme looks portable and is a
footgun the moment two displays or a zoom exist.

Out of range → that action is `error` with `OUT_OF_BOUNDS`. The rest
of the batch is `SKIPPED`.

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

v1: the hub emits `credential` when a password field is focused, and
`destructive` when a known confirm dialog is frontmost. The model
calls `request_takeover`. The human uses the seat. No model-side
acknowledge RPC in v1 — the seat *is* the acknowledge.

### Idempotency

`request_id` is required. A retry with the same id returns the first
response. A new id runs a new batch. This is how a flaky transport
does not double-click.

## Shell and files

`shell` runs `argv` in `/workspace` (or `cwd` under it). Timeout
1–120s, default 30. Output is stdout, stderr, exit, truncated flags.

`read_file` / `write_file` take a path. Absolute paths must start
with `/workspace`. Relative paths resolve there. `..` after resolve
is `PATH_REJECTED`.

These are not computer-use. They exist so the model does not have to
open an editor to change a file.

## Errors

One envelope everywhere:

```
{ "error": { "code": "SEAT_HELD", "message": "human has the seat" } }
```

| Code | When |
|---|---|
| `UNAUTHENTICATED` | missing or bad bearer |
| `SEAT_HELD` | caller does not own the seat |
| `OUT_OF_BOUNDS` | coordinate outside 1280×800 |
| `PATH_REJECTED` | path escapes `/workspace` |
| `DAEMON_DOWN` | desk exec or input is dead |
| `VALIDATION` | bad request |
| `CONFLICT` | `request_id` reused with a different body |

HTTP status follows the code: 401, 409, 400, 400, 503, 400, 409.

## What the phone does

`Pair` exchanges the setup code for a bearer and a `vncUrl`.
`Status` returns `{ state, vncUrl, display, screens }`.
Seat calls take an additive `display` to pick a screen (see Screens).
`Pointer` is the trackpad: `move` deltas or `click` at the current
pointer. It does not take screenshot coordinates — the human is
looking at the stream.
`Type` is the iOS keyboard: unicode into the focused field.
`ClipboardGet` / `ClipboardSet` are UTF-8 only in v1.
`SetPresence(false)` is `I'm done`.
`CreateBot` / `DeleteBot` provision Bots (see Screens) — the phone is
the box owner, so provisioning lives on the seat, never on the model.

The VNC stream is view-only. The phone never sends RFB pointer
events. Input is `Seat.Pointer` so the hub can enforce the seat.

## Adapters

Native is the protocol. Hosted CUAs wrap it.

| Foreign | Maps to |
|---|---|
| OpenAI `computer` `actions[]` | `Agent.Computer.actions` (same names; drop `pending_safety_checks` handling in favour of `pending_checks` + `request_takeover`) |
| Claude `computer_toolset_20260801` | strip `left_click` → `click`; `zoom` kept; per-action results already match |
| Gemini `computer_use` | **divide** 0–999 by 999, multiply by 1280/800, round. Do not emit 0–999 from this API. Drop `navigate` — type into the URL bar. |

A 64-tool MCP server is not an adapter. It is the thing this design
refuses.

The reference external harness is `apps/eve` (eve.dev): four `defineTool`
wrappers over the Agent RPCs, screenshots forwarded as vision input via
`toModelOutput`. Any harness that can hold a bearer token and POST JSON
can be a Bot's brain.

## Version

`computer.v1`. Additive fields are fine. New actions require v2.
`GET /spec` reports `version`.
