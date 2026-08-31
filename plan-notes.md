# Computer implementation notes

## Deviations

- `Seat.Pointer` JSON accepts additive `{ type: "move", dx, dy, grab }` so the iPhone trackpad can drag. Proto `PointerMove` has only `dx`/`dy`; `grab` is JSON-only until v2.
- `Seat.Pointer` JSON accepts additive `{ type: "scroll", dx, dy }` for two-finger scroll (same reason).
- Hub speaks Connect-JSON unary from `api/types.ts` rather than generated protobuf-es stubs. `packages/proto/computer.proto` is byte-identical to `api/computer.proto` (`npm run proto:check`).
- Desk image installs Chromium when the distro package exists; entrypoint still starts the VNC session if the browser package is missing.

## Run end

(not started — host tests next)
