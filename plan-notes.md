# Computer implementation notes

## Deviations

- `Seat.Pointer` JSON accepts additive `{ type: "move", dx, dy, grab }` so the iPhone trackpad can drag. Proto `PointerMove` has only `dx`/`dy`; `grab` is JSON-only until v2.
- `Seat.Pointer` JSON accepts additive `{ type: "scroll", dx, dy }` for two-finger scroll (same reason).
- Hub still speaks Connect-JSON unary (DESIGN error envelope) rather than `@connectrpc/connect-node`. Method paths and types come from `buf generate` (`protoc-gen-es`).
- `Seat.Type` request type is written `computer.v1.Type` in the proto. Bare `Type` is rejected by protoc/buf (method name shadows the message). Wire path is still `/computer.v1.Seat/Type`.
- iOS chat/seat client stays Codable JSON. Buf also emits SwiftProtobuf + Connect-Swift under `packages/proto/gen/swift` for a later Connect-Swift client.
- Desk image installs Chromium when the distro package exists; entrypoint still starts the VNC session if the browser package is missing.

## Run end

Host (this Linux agent, 2026-08-31):

```
npm run proto:check   # copy + buf lint + generate + gen/ committed
npm run lint          # desk ↛ handler
npm test --workspace=apps/hub
```

Not run here (no Docker, no Xcode, no iPhone):

- `docker compose up` / TigerVNC + uinput against Chromium
- `xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test`
- Seven-step cellular verification (pair → chat → Open Computer → seat → paste → I’m done → lock 30s)

No STOP fired. Product finish line is still that iPhone run.
