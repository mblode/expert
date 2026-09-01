# Computer: standing Linux box + iOS app

Executor: keep deviations in [plan-notes.md](plan-notes.md) under `## Deviations`. Finish when the iPhone verification below passes, or a STOP fires.

## Context

Grok Bot’s computer is a shared Linux **box** the agent drives, plus a phone client that can take the seat. Public 0.18 reconstruction ([b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed)) shows the desktop contract: VNC URL, 1280×800, clipboard and user-presence **beside** VNC, exec over ConnectRPC, one shared box. The iOS app is not in that repo. This plan is a clean-room Apache-2.0 implementation of that contract, with iOS as a first-class client — not a later wrap of noVNC.

## Approach

One host process, one container, one iOS app.

```text
iPhone (Computer.app)
  SwiftUI chrome: pair, chat, seat, clipboard, trackpad, I'm done
  WKWebView: pixels only (noVNC view-only at vncUrl)
  HTTPS to hub on Tailscale
        │
        ▼
hub  (TypeScript, loopback + Tailscale Serve)
  ConnectRPC: exec, files, presence, clipboard, pointer
  Serves noVNC + vncUrl
        │
        ▼
desk (Docker)
  Debian, Openbox, Chromium, TigerVNC :5900, 1280×800
  Volume: /workspace + ~/.config (all Chromium profiles, not just window 1)
  XTEST via xdotool for pointer (not XSendEvent)
```

**iOS is the product surface.** Hub and desk exist so the phone has something to drive after the MacBook lid closes.

### iOS app (`apps/ios`)

SwiftUI, iOS 18+. TestFlight. No App Store in this plan.

| Screen | What it does |
|---|---|
| Pair | Paste setup code / scan QR. Saves `https://computer.<tailnet>.ts.net` + token in Keychain. |
| Chat | One thread. Stream hub agent replies. Attach “Open computer”. |
| Computer | Full-bleed VNC. Native bottom bar. Waiting banner when seat is `WAITING`. |

Computer chrome (native, not in the webview):

- Keyboard → `Seat.Type` into the focused field
- Clipboard sheet → Copy to iPhone / Paste from iPhone (`Seat.ClipboardGet` / `Seat.ClipboardSet`)
- Trackpad mode (… menu) → `Seat.Pointer` move deltas; tap clicks; double-tap-hold drags
- Gestures on the view (when trackpad is off): tap click, one-finger drag, two-finger scroll, two-finger / press-hold right-click, pinch zoom then two-finger pan
- **I’m done** → `Seat.SetPresence({ present: false })`

Gesture copy matches Grok’s help card. Coordinate space is 1280×800, origin top-left. Overlay maps view points → that space. Recenter pointer if it drifts.

WKWebView loads `vncUrl` **view-only**. All input goes through hub pointer RPCs. That is the 0.18 split (trusted desktop frame for pixels, IPC for clipboard and presence) without writing an RFB stack.

### Protocol

Source of truth: [api/DESIGN.md](api/DESIGN.md). Agent-loadable JSON: [api/spec.json](api/spec.json). Wire: [api/computer.proto](api/computer.proto). Types: [api/types.ts](api/types.ts).

Two services. Four model tools. A seat.

| Service | Audience | RPCs |
|---|---|
| `Agent` | model | `Spec`, `Computer`, `Shell`, `ReadFile`, `WriteFile` |
| `Seat` | iPhone | `Pair`, `Status`, `SetPresence`, `Pointer`, `Type`, `ClipboardGet`, `ClipboardSet` |

Do not expose clipboard, `vncUrl`, or pointer as model tools. Chat stays a hub stream beside these services; it is not a computer-use verb.

`computer` is one discriminated union (11 actions), sequential, per-action results, skip-the-rest on first failure. Coordinates are pixels of the last full 1280×800 screenshot. `zoom` does not rematch that space. `request_id` is required. Seat is `AGENT | WAITING | HUMAN`. I'm done is `SetPresence(false)`.

Auth: setup-code pairing, then bearer. Bind `127.0.0.1`; Tailscale Serve publishes HTTPS. A Connect method without an auth policy fails registration.

Agent loop in hub, BYO API key. After `WAITING`, iOS shows the banner.

### Desk (`apps/desk`)

One Docker image. TigerVNC 1280×800. Chromium. Persistent volume. Non-root `box` user. Recreate keeps the volume.

## Key decisions

- **Frame:** clean-room box. 0.18 is the spec, not a fork. No shipped renderer, no asar.
- **Pixels = VNC, not WebRTC.** 0.18 already does this. iOS uses the same `vncUrl`.
- **iOS ships in the first tracer.** Pair → see desktop → take seat → paste from iPhone → I’m done → agent continues. Laptop web viewer is debug-only (`apps/hub` static page), not a product.
- **One box, many Bots, one screen per Bot.** Window index = X display: primary `:1`, forks `:2`–`:8`, RFB on `5900 + N`. Claims live in `~/.window-assignments.json` on the box with sha256 owner hashes. Agent token → Bot → screen; the seat FSM is per screen. Default config is still exactly one Bot on `:1`.
- **Protocol is [api/DESIGN.md](api/DESIGN.md).** One action union, Claude skip-the-rest, pixel coords, seat FSM. Not a 64-tool MCP server. Not Gemini 0–999.
- **1280×800.** Agent and iOS share that sentence; do not add resolution settings.
- **XTEST for pointer.** TigerVNC `XSendEvent` is ignored by GTK. uinput was the first guess and is a dead end against a virtual X server: it injects into the kernel input layer, which Xvnc never reads, so it exits 0 and moves nothing. XTEST is real input at the X server and drives Chromium; it also works on a real Xorg desktop, so there is no second backend.
- **No Next.js, Vercel, or Fly.** Constraint is a standing Linux desktop. Deploy: Docker Compose on a Hetzner box (CX33 €8.49/mo is the sweet spot; CX43 €15.99/mo post the June-2026 price rise) or any always-on Docker host + Tailscale. Cloudflare Tunnel + Access browser-rendered VNC is a clientless alternative front door — noted, not adopted.
- **TypeScript monorepo for hub/proto only.** iOS is Xcode; desk is a Dockerfile. Do not invent a shared React Native client.

## Repo shape

```text
apps/hub/          # ConnectRPC server, noVNC static, agent loop
apps/desk/         # Dockerfile + entrypoint
apps/ios/          # Xcode: Computer.xcodeproj, SwiftUI
packages/proto/    # computer.proto → TS + Swift (copy of api/computer.proto)
packages/shared/   # branded IDs, error codes (TS)
```

No `packages/ui`. Two clients (WKWebView debug page, iOS) is not a third design system.

Hub modules: `handler` (Connect adapters) → `service` (seat, clipboard, agent) → `desk` (docker exec / VNC / XTEST). Lint: `desk` and `service` may not import `handler`.

## Out of scope

- Named Bot roster UI, routines, teach-by-demo, plugins marketplace
- Driving the user’s MacBook
- Per-Bot security isolation (Bots share the box and are not security boundaries)
- App Store submission
- Poke/Town/OpenClaw features (inbox, iMessage, camera node)
- Forking or vendoring 0.18 reconstructed sources

## Verification

On a real iPhone on **cellular**, MacBook lid shut:

1. `docker compose up` on the host; Tailscale Serve healthy.
2. Open Computer.app → pair with setup code.
3. Chat: “install wine, open a terminal, echo ok”.
4. Open Computer: desktop visible, 1280×800.
5. Take seat: tap to click, trackpad mode, paste a path from the iPhone clipboard.
6. Tap I’m done. Agent continues and replies.
7. Lock the phone for 30s; reopen; stream still up or reconnects without re-pair.

Commands on the host:

```sh
npm run proto:check
npm test --workspace=apps/hub
xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Simulator proves pair + RPC. Only the cellular run proves the product.

## STOP conditions

- ~~TigerVNC + uinput cannot click Chromium or a GTK app~~ → **fired and resolved.** uinput could not; XTEST can, verified against real Chromium. No `XSendEvent` anywhere.
- WKWebView cannot show view-only noVNC without stealing gestures → stop, switch that webview to a still-JPEG fallback only after logging it; do not start a WebRTC rewrite.
- Tailscale Serve cannot reach the phone on cellular → stop, do not bind hub to `0.0.0.0`.

## Acceptable finish

The seven-step iPhone verification passes once. Implementation notes end with that evidence. Extra chrome (help card, pinch polish) can follow; a second Bot cannot.

## Cut list (kept out)

WebRTC, mediasoup, Pion, per-Bot screens, Nix package persistence, App Store, React Native, Next.js, a generic remote-desktop framework, forking 0.18.
