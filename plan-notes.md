# Computer implementation notes

## Deviations

- Hub speaks Connect-JSON unary (DESIGN error envelope) rather than `@connectrpc/connect-node`. Method paths and types come from `buf generate` (`protoc-gen-es`).
- iOS chat/seat client stays Codable JSON (`apps/ios/.../ComputerV1.swift`). Buf emits SwiftProtobuf + Connect-Swift under `packages/proto/gen/swift` for a later Connect-Swift client.
- Seat pixels (`/vnc`, `/websockify`) require the paired seat token (`?token=` or `Authorization`). The model token cannot call Seat RPCs or read `vncUrl`.
- Desk image installs Chromium when the distro package exists; entrypoint still starts the VNC session if the browser package is missing.

## Multi-screen + provisioning run (2026-08-31)

Backwards compatibility was explicitly dropped in this run; the protocol
below is the only contract.

- `display` is first-class on every Seat request that targets a screen (`StatusRequest`, `SetPresenceRequest`, `PointerRequest`, `SeatTypeRequest`, `ClipboardGetRequest`, `ClipboardSetRequest`); dedicated Seat messages replaced the shared-with-Agent ones, which also removed the old `computer.v1.Type` shadow workaround.
- Bots are provisioned at runtime (`Seat.CreateBot` / `Seat.DeleteBot`, `npm run bot -- new|rm`), never via env config. The roster (with tokens) persists in `COMPUTER_DATA` (default `data/bots.json`, gitignored, mode 0600). Boot with an empty store auto-provisions `main` on `:1` with a minted `bot_…` token.
- `COMPUTER_SETUP_CODE` is the only secret input and `npm run up` generates it; `COMPUTER_AGENT_TOKEN` and `COMPUTER_BOTS` no longer exist.
- `COMPUTER_VNC_PORT` is a **base port**: window N dials `base + N`, so primary `:1` is 5901 (also fixes the earlier compose mismatch where 5900 was published while `vncserver :1` listened on 5901).
- Every display is driven by XTEST via `xdotool` with `DISPLAY=:N`. (Superseded below: the uinput backend was measured to be a no-op against Xvnc and has since been deleted outright.)
- Owner identity on the box is `sha256(bot token)` in `~/.window-assignments.json` — raw bearers never land on the shared filesystem.

## Eve run (2026-08-31)

Eve (eve.dev, Vercel's agent framework) is now the reference harness; this
supersedes the briefly-started "persistent per-Bot threads in the hub" idea —
Eve's durable workflows are the persistent thread, and the hub's chat loop
stays only as the zero-dependency fallback.

- `apps/eve/` is a standalone Eve app (deliberately NOT a root npm workspace:
  the eve runtime needs Node ≥24 while the hub runs ≥20, and its package
  depends on `eve` which would collide with workspace linking).
- The four tools wrap the Agent RPCs; `computer` uses `toModelOutput` to hand
  every screenshot/zoom image to the model as vision input while keeping the
  text summary image-free. `shell` carries Eve's `once()` approval gate.
- Verified with the tool executors driven directly against a fake-desk hub:
  write/read round-trip, shell echo, screenshot→vision parts,
  `request_takeover` → WAITING, `SEAT_HELD` surfaced as a tool error. The
  interactive `npm run eve` REPL needs a model key (AI Gateway) — user-side.

## First run on real hardware (2026-09-01, macOS + OrbStack, arm64)

The box now runs for real. Everything below was found by running it, not by
reading it, and the fixes are in this branch.

- **The STOP condition is resolved, and the answer is XTEST.** `uinputd move`
  exits 0 against the desk and the X pointer never moves: uinput injects into
  the kernel input layer, which a virtual X server (Xvnc) never reads. XTEST
  via `xdotool` does move it, and drives Chromium — the agent focused the URL
  bar, typed, pressed Return, and example.com then wikipedia.org loaded. XTEST
  is not the `XSendEvent` the design refused; it is real input at the X server,
  which GTK and Chromium honour. Default backend is now `xtest` everywhere;
  uinput has since been deleted: XTEST also works on a real Xorg desktop, so it won in no environment we support, and leaving it selectable meant a config that silently ignored every input.
- **Debian, not Ubuntu.** Ubuntu's `chromium-browser` is a snap transition stub:
  it installs, and running it prints "requires the chromium snap to be
  installed". Debian 12 ships a real chromium on amd64 and arm64.
- **Xvnc directly, not the `vncserver` wrapper.** The wrapper refuses
  passwordless mode without `--I-KNOW-THIS-IS-INSECURE` and wants a
  `tigervncpasswd` binary Debian does not ship. Running `Xvnc` also let us set
  `-AcceptKeyEvents=0 -AcceptPointerEvents=0`, so **view-only is now enforced
  at the server**: clicking a link inside the noVNC viewer moved nothing on the
  box. Pixels out, input only through the seat.
- **flock deadlock.** `start-window` held its lock on fd 9, and the Xvnc it
  started inherited that fd — so the lock was never released and every later
  `start-window` blocked until `docker exec` timed out. The claim now runs in a
  subshell whose fd dies with it.
- **Stale sockets lie.** After a restart `/tmp/.X11-unix/XN` still exists with
  no server behind it, and the idempotency check reported a dead desktop as up.
  It now probes with `xdpyinfo` and clears the socket before restarting.
- **The box survives a restart.** Claims live on the `/workspace` volume and the
  entrypoint restores every claimed fork, so `docker compose restart` brings
  back Eve's screen, not just `:1`. The hub also force-reclaims a stale claim at
  boot: a lost `data/bots.json` used to brick startup with CONFLICT.
- `npm run up` now checks `docker info`, not `docker --version`: the CLI
  succeeds with the daemon stopped, which is the normal state on a Mac.

Verified end to end against the real desk: agent screenshot (1280×800 PNG),
agent drives Chromium, shell + files on the box, provision `eve` onto screen 2,
per-screen `SEAT_HELD` (eve blocked, main unaffected), noVNC streaming live in
a desktop browser, a viewer click refused, a **seat** click navigating the page,
`I'm done` returning the seat, and Eve's own tools (`apps/eve`) driving the box
with the screenshot arriving as a vision part.

Still unverified: the iPhone app itself (needs Xcode and a device) and the
seven-step cellular run.

## Per-Bot state on the box (2026-09-01)

Bots had a host-side roster and nothing of their own on the machine they
drive. They now get `/workspace/.bots/<id>/`.

- **Not `~/sand-data/agents/<id>/`**, which is where Grok puts it. `$HOME` is
  not on a volume here, so a rebuild would erase it — the row the README's
  persistence table calls out. `/workspace` survives, and
  `.window-assignments.json` already lives there for the same reason.
- Contents: `profile.json` (Grok's fields, snake_cased like the rest of our
  on-box JSON), `memory/profile.md` (dated `- (YYYY-MM-DD) [note|episode]`
  fact lines, ~500 chars, identity = sha1 of the normalised text so a fact
  written twice is one entry), and `transcript.jsonl`. No `settings.json` and
  no `automations/`: we have neither feature, and an empty stub is not a
  contract.
- **The token stays on the host.** Nothing under the box path contains a
  bearer — tested. `/workspace` is shared by every Bot, so this directory is
  organisation, not isolation.
- The **occurrence log is now durable**. It was process memory, so every hub
  restart silently wiped the human's thread. `VoiceService` writes each
  occurrence behind the caller (a bubble does not wait on a `docker exec`) and
  `ProvisionService` reads it back at boot. `seq` survives, so a cursor the
  phone held still means what it meant, and a widget that ended a turn is
  still ended after the restart. A Bot whose transcript could not be read does
  not persist for that run — numbering a second run from 1 into the same file
  is the one way to actually corrupt it.
- **Deleting a Bot keeps its directory.** A roster row is not a human's record
  of what happened on their computer, and Grok draws the same line. A Bot
  re-created under a name it had before adopts what it left behind.
- Memory has one writer and one reader: the agent writes lines with the
  `write_file` tool it already has (the seeded header is where the format is
  stated), and the hub's chat loop reads profile + memory into the system
  prompt. No new RPC, no sixth tool, no proto change.
- `Desk` gained `appendFile`. The transcript is append-only; rewriting it
  whole per bubble would re-send the file through `docker exec` every time and
  put every earlier line behind a truncating write.

## Run end

Host (this Linux agent, 2026-08-31):

```
npm run proto:check   # copy + buf lint + generate + gen/ committed
npm run lint          # desk ↛ handler
npm test              # hub tests pass
node scripts/computer.mjs   # CLI smoke: up-less usage, bot new/ls/rm/token against a fake-desk hub
```

Not run here (no Docker, no Xcode, no iPhone):

- ~~`docker compose up` / TigerVNC input vs Chromium~~ — done, see above
- `xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test`
- Seven-step cellular verification (pair → chat → Open Computer → seat → paste → I'm done → lock 30s)

No STOP fired. Product finish line is still that iPhone run. STOP conditions extend to: XTEST cannot click Chromium on a fork display.
