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
- Fork displays (`:2+`) use XTEST via `xdotool` with `DISPLAY=:N` (uinput is kernel-global and cannot target one X display). Primary keeps uinputd; `COMPUTER_INPUT_BACKEND` overrides.
- Owner identity on the box is `sha256(bot token)` in `~/.window-assignments.json` — raw bearers never land on the shared filesystem.

## Run end

Host (this Linux agent, 2026-08-31):

```
npm run proto:check   # copy + buf lint + generate + gen/ committed
npm run lint          # desk ↛ handler
npm test              # hub tests pass
node scripts/computer.mjs   # CLI smoke: up-less usage, bot new/ls/rm/token against a fake-desk hub
```

Not run here (no Docker, no Xcode, no iPhone):

- `docker compose up` / TigerVNC + uinput (:1) and XTEST vs Chromium (:2+)
- `xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test`
- Seven-step cellular verification (pair → chat → Open Computer → seat → paste → I'm done → lock 30s)

No STOP fired. Product finish line is still that iPhone run. STOP conditions extend to: XTEST cannot click Chromium on a fork display.
