# Computer implementation notes

## Deviations

- `Seat.Pointer` JSON accepts additive `{ type: "move", dx, dy, grab }` so the iPhone trackpad can drag. Proto `PointerMove` has only `dx`/`dy`; `grab` is JSON-only until v2.
- `Seat.Pointer` JSON accepts additive `{ type: "scroll", dx, dy }` for two-finger scroll (same reason).
- Hub still speaks Connect-JSON unary (DESIGN error envelope) rather than `@connectrpc/connect-node`. Method paths and types come from `buf generate` (`protoc-gen-es`).
- `Seat.Type` request type is written `computer.v1.Type` in the proto. Bare `Type` is rejected by protoc/buf (method name shadows the message). Wire path is still `/computer.v1.Seat/Type`.
- iOS chat/seat client stays Codable JSON (`apps/ios/.../ComputerV1.swift`). Buf emits SwiftProtobuf + Connect-Swift under `packages/proto/gen/swift` for a later Connect-Swift client. The unused hand-written `packages/proto/swift/ComputerTypes.swift` copy was deleted.
- Seat pixels (`/vnc`, `/websockify`) require the paired seat token (`?token=` or `Authorization`). The model token cannot call Seat RPCs or read `vncUrl`.
- Desk image installs Chromium when the distro package exists; entrypoint still starts the VNC session if the browser package is missing.

Multi-screen run (2026-08-31):

- `display` on `Seat.Type`, `Seat.ClipboardGet`, `Seat.ClipboardSet` is JSON-additive only (those messages are shared with the Agent action union); the proto carries `display` on `StatusRequest`, `SetPresenceRequest`, `PointerRequest`, plus `ScreenStatus` and `BoxStatus.screens`.
- `COMPUTER_VNC_PORT` is now a **base port**: window N dials `base + N`, so primary `:1` is 5901. This also fixes the earlier compose mismatch (published 5900 while `vncserver :1` listened on 5901).
- Fork displays (`:2+`) use XTEST via `xdotool` with `DISPLAY=:N` (uinput is kernel-global and cannot target one X display). Primary keeps uinputd; `COMPUTER_INPUT_BACKEND` overrides. TigerVNC+uinput on `:1` and XTEST-vs-Chromium on forks are both still unverified without Docker — the STOP condition extends to "XTEST cannot click Chromium on a fork display".
- Owner identity on the box is `sha256(bot token)` in `~/.window-assignments.json` — raw bearers never land on the shared filesystem.

## Run end

Host (this Linux agent, 2026-08-31):

```
npm run proto:check   # copy + buf lint + generate + gen/ committed
npm run lint          # desk ↛ handler
npm test --workspace=apps/hub   # 35 passed
```

Not run here (no Docker, no Xcode, no iPhone):

- `docker compose up` / TigerVNC + uinput against Chromium
- `xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test`
- Seven-step cellular verification (pair → chat → Open Computer → seat → paste → I’m done → lock 30s)

No STOP fired. Product finish line is still that iPhone run.
