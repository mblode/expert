# Computer

A persistent Linux computer that agents drive and a human can take the seat of. npm workspaces monorepo: `apps/hub` (TypeScript hub), `apps/web` (Next.js 16 on Vercel), `apps/eve` (eve.dev agent, runs beside the hub), `apps/desk` (Debian guest image), `packages/shared` and `packages/proto`.

## Commands

- `npm install` (Node 24; `prepare` installs the lefthook pre-commit hook)
- `npm run check`: typecheck every workspace, layer lint, `ultracite check` (oxlint + oxfmt), knip, hub tests, proto check. CI runs this same command.
- `npm run fix`: format and autofix (`ultracite fix`)
- `npm test`: hub tests (vitest). One file: `npx vitest run test/computer.test.ts --reporter=dot` from `apps/hub`
- `npm run typecheck`: all workspaces; one: `npm run typecheck --workspace=apps/hub`
- `npm run proto:check` after editing `api/computer.proto`: it must be byte-identical to `packages/proto/computer.proto`, then `npm run proto:gen` and commit `packages/proto/gen`
- `npm run up`: local box (needs a Docker daemon; falls back to a fake desk). `npm run web`: Next dev on :3000 against the local hub on :8787
- `npm run bot -- new|ls|rm <id>`: provision Bots against a running hub

## Contract

`api/DESIGN.md` is the source of truth for the wire; `api/spec.json` is what a model loads; `packages/shared/src/index.ts` holds the types and error codes. Change all three together. The hub speaks the proto's RPC names as plain JSON POST, not Connect binary; a buf-generated client cannot talk to it.

## Gotchas

- Hub layering is `handler -> service -> desk`; `scripts/lint-layers.mjs` fails the build on an upward import. Put HTTP parsing in `handler`, rules in `service`, `docker exec`/XTEST in `desk`.
- The model's five tools (`send_message`, `computer`, `shell`, `read_file`, `write_file`) are the whole model surface. Clipboard, `vnc_url`, pointer and provisioning are Seat RPCs only; adding them to the model is the injection path `api/DESIGN.md` refuses.
- Coordinates are integer pixels of the last full 1280x800 screenshot, origin top-left, and `zoom` does not change that space. Never introduce normalised 0..999 coordinates.
- A `computer` batch is validated whole before anything runs; a limit violation is a 400 for the request. Do not move per-action limits back into the execution loop, or a partially-run batch becomes unretryable under its `request_id`.
- Human input is never RFB: x11vnc runs `-viewonly`, and every pointer/keystroke goes through `Seat.Pointer`/`Seat.Type` so the seat FSM can refuse it.
- `apps/eve` files import each other with `.ts` extensions (`allowImportingTsExtensions`); `eve build` bundles them. The bot dir `apps/eve/bots/main` re-exports from `../../lib`.
- Every signed-in hello.expert user shares the one computer this deployment fronts and becomes its owner. Set `AUTH_ALLOWED_EMAILS` on any deployment that is not private.
- On the Fly guest, `/workspace/.computer` (roster, seat tokens, Eve secret) is readable by anything running as `box`, the model included. Do not write new secrets there; `COMPUTER_SETUP_CODE` must be a Fly secret.
- `apps/web` typecheck reads `.next/types`; a route you deleted can leave a stale reference until `rm -rf apps/web/.next && npx next build`.
- `apps/hub/test/eve-channel-auth.test.ts` is excluded from the hub tsconfig because it imports `apps/eve`; vitest still runs it.
- No Docker daemon in Claude Code on the web and similar sandboxes: `npm run up` uses the fake desk, and the desk image smoke test only runs in CI.

## Conventions

- Comments explain why, and the code around them is dense with them; match that density rather than adding what-comments.
- No em dashes in prose or comments; use commas, colons, or a new sentence.
- Errors on the wire are one envelope: `{ error: { code, message } }` with a code from `ErrorCode` in `packages/shared`. Throw `ComputerError`; anything else becomes a 500 `DAEMON_DOWN`.
- Secrets never land in `process.env` of a child the model can reach, in logs, or in an error message (see `ProvideSecret` in `apps/hub/src/service/voice.ts` for the pattern).
- Generated output under `packages/proto/gen` is committed; never hand-edit it.

## Do not commit

`data/` (roster and seat tokens), `.env`, `apps/web/.next`, `**/.eve`.

## References

- Audit and open findings: `docs/AUDIT.md`
- Grok Bot research, gap analysis, roadmap: `docs/GROK-BOT.md`
- Design rationale and sources: `api/RESEARCH.md`; historical plan: `docs/history/`
- Eve project layout and adding a bot: `apps/eve/README.md`
