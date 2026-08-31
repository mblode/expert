# Computer

A standing Linux **box** plus an iPhone client that can take the seat.

iPhone (Computer.app) → hub (ConnectRPC on loopback + Tailscale Serve) → desk (Docker, TigerVNC 1280×800).

Protocol: [api/DESIGN.md](api/DESIGN.md). This is a clean-room Apache-2.0 implementation of that contract. 0.18 is the spec, not a fork.

## Shape

```
apps/hub/       ConnectRPC, noVNC static, agent loop
apps/desk/      Ubuntu + Openbox + Chromium + TigerVNC + uinput
apps/ios/       Computer.xcodeproj (SwiftUI, iOS 18+)
packages/proto  buf generate (protoc-gen-es + Swift) from api/computer.proto
packages/shared branded IDs, error codes
```

Two services. Four model tools. A seat.

| Service | Audience | RPCs |
|---|---|---|
| `Agent` | model | Spec, Computer, Shell, ReadFile, WriteFile |
| `Seat` | iPhone | Pair, Status, SetPresence, Pointer, Type, ClipboardGet, ClipboardSet |

Clipboard, `vncUrl`, and pointer are **not** model tools. VNC is view-only. Input is `Seat.Pointer`.

## Host

```sh
cp .env.example .env
# set COMPUTER_SETUP_CODE, COMPUTER_AGENT_TOKEN, COMPUTER_PUBLIC_URL

docker compose up -d --build
npm install
COMPUTER_DESK=docker npm run hub
```

Publish HTTPS with Tailscale Serve. Do not bind the hub to `0.0.0.0`.

```sh
tailscale serve --bg http://127.0.0.1:8787
```

Pairing QR payload:

```
computer://pair?host=https://computer.<tailnet>.ts.net&code=<setup-code>
```

BYO LLM key (`OPENAI_API_KEY`) for the chat agent loop. Without it the hub still pairs, streams the desktop, and runs the four tools over Connect.

## iPhone

Open `apps/ios/Computer.xcodeproj` on a Mac. TestFlight, not App Store.

Simulator proves pair + RPC:

```sh
xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

The product proof is cellular, lid shut: pair → chat → Open Computer → take seat → paste → I’m done → lock 30s → reconnect.

## Checks

```sh
npm run proto:gen      # buf lint is included in proto:check
npm run proto:check    # copy + buf lint + generate + gen/ is committed
npm test --workspace=apps/hub
```

`api/computer.proto` is the source of truth. `buf.yaml` compiles it; `packages/proto/gen` is the committed output (TypeScript + Swift).
