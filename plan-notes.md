# Computer implementation notes

## Deviations

- `Seat.Pointer` JSON accepts additive `{ type: "move", dx, dy, grab }` so the iPhone trackpad can drag. Proto `PointerMove` has only `dx`/`dy`; `grab` is JSON-only until v2.
- `Seat.Pointer` JSON accepts additive `{ type: "scroll", dx, dy }` for two-finger scroll (same reason).
- Hub speaks Connect-JSON unary from `api/types.ts` rather than generated protobuf-es stubs. `packages/proto/computer.proto` is byte-identical to `api/computer.proto` (`npm run proto:check`).
- Desk image installs Chromium when the distro package exists; entrypoint still starts the VNC session if the browser package is missing.

## Run end

Host (this Linux agent, 2026-08-31):

```
npm run proto:check   # ok
npm run lint          # desk ↛ handler
npm test --workspace=apps/hub   # 33 passed
```

Not run here (no Docker, no Xcode, no iPhone):

- `docker compose up` / TigerVNC + uinput against Chromium
- `xcodebuild -project apps/ios/Computer.xcodeproj -scheme Computer -destination 'platform=iOS Simulator,name=iPhone 16' test`
- Seven-step cellular verification (pair → chat → Open Computer → seat → paste → I’m done → lock 30s)

No STOP fired. Product finish line is still that iPhone run.
