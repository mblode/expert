# Computer

A persistent Linux computer that agents drive and a human can take the seat of. npm workspaces monorepo: `apps/hub` (TypeScript hub), `apps/web` (Next.js 16 on Vercel), `apps/eve` (eve.dev agent, runs beside the hub), `apps/whatsapp-bridge` (Baileys WhatsApp socket, runs beside the hub), `apps/desk` (Debian guest image), `packages/shared` and `packages/proto`.

## Commands

- `npm install` (Node 24; `prepare` installs the lefthook pre-commit hook)
- `npm run check`: typecheck every workspace, layer lint, `ultracite check` (oxlint + oxfmt), knip, hub tests, proto check. CI runs this same command.
- `npm run fix`: format and autofix (`ultracite fix`)
- `npm test`: hub tests (vitest). One file: `npx vitest run test/computer.test.ts --reporter=dot` from `apps/hub`
- `npm run typecheck`: all workspaces; one: `npm run typecheck --workspace=apps/hub`
- `npm run proto:check` after editing `api/computer.proto`: it must be byte-identical to `packages/proto/computer.proto`, then `npm run proto:gen` and commit `packages/proto/gen`
- `npm run up`: local box (needs a Docker daemon; falls back to a fake desk). `npm run web`: Next dev on :3000 against the local hub on :8787
- `npm run bot -- new|ls|rm <id>`: provision Bots against a running hub; `npm run bot -- connector add|ls|rotate|rm` edits `connectors.json`
- `npm test --workspace=apps/eve`: the shared Eve lib (channel, format-reply); `npm test --workspace=apps/whatsapp-bridge`: the bridge (`node --test`)

## Contract

`api/DESIGN.md` is the source of truth for the wire; `api/spec.json` is what a model loads; `packages/shared/src/index.ts` holds the types and error codes. Change all three together. The hub speaks the proto's RPC names as plain JSON POST, not Connect binary; a buf-generated client cannot talk to it.

## Gotchas

- Hub layering is `handler -> service -> desk`; `scripts/lint-layers.mjs` fails the build on an upward import. Put HTTP parsing in `handler`, rules in `service`, `docker exec`/XTEST in `desk`.
- The model's five tools (`send_message`, `computer`, `shell`, `read_file`, `write_file`) are the whole model surface. Clipboard, `vnc_url`, pointer and provisioning are Seat RPCs only; adding them to the model is the injection path `api/DESIGN.md` refuses.
- Coordinates are integer pixels of the last full 1280x800 screenshot, origin top-left, and `zoom` does not change that space. Never introduce normalised 0..999 coordinates.
- A `computer` batch is validated whole before anything runs; a limit violation is a 400 for the request. Do not move per-action limits back into the execution loop, or a partially-run batch becomes unretryable under its `request_id`.
- Human input is never RFB: x11vnc runs `-viewonly`, and every pointer/keystroke goes through `Seat.Pointer`/`Seat.Type` so the seat FSM can refuse it.
- `apps/eve` files import each other with `.ts` extensions (`allowImportingTsExtensions`); `eve build` bundles them. The bot dir `apps/eve/bots/main` re-exports from `../../lib`.
- hello.expert is the control plane, and the **account** is the tenant boundary: a signed-in email is bound to one computer (hub URL + seat) through `COMPUTER_BINDINGS`. Blode is `mblode-computer`; Vibey is `vcmc-computer`, a separate login, not a Bot on Blode. Both lookups in `apps/web/lib/computers.ts` fail closed: an email with no binding gets **no** computer (set `DEFAULT_COMPUTER_ID` to opt every unbound account into one), and `COMPUTER_OPERATOR_EMAILS` unset means **nobody** may switch computers or mint invites, so list yourself there or you keep only your bound computer. Set `AUTH_ALLOWED_EMAILS` on any deployment that is not private.
- On the Fly guest the hub runs as user `hub`, not `box`: `/workspace/.computer` (roster, seat tokens, connector secrets, Eve secret, Baileys credentials) is hub-owned at 0700 and the model's `shell` cannot read it. Desk commands run as `box` through `sudo -u box` (`asBox` in `apps/hub/src/desk/docker.ts`, enabled by `COMPUTER_RUN_AS=box`, one line in `/etc/sudoers.d/hub`). `COMPUTER_SETUP_CODE` must be a Fly secret; init refuses to mint one on a cloud deployment.
- The bridge has two kinds of credential and they are not interchangeable. `WHATSAPP_BRIDGE_SECRET` is the **admin** one the hub holds: it opens every route for every account, and it is the only thing that may touch `/accounts`. Each account also carries its own `bridge_secret`, minted into `accounts.json` (and by boot, for a file written before they existed), which opens the data routes for that account alone. `acct` comes from the credential, never from the query or body, and a request naming a different account is a 403: with one shared secret and `acct` read off the request, any holder could read any account's messages, which is invisible on a single-tenant loopback bridge and a cross-tenant read the moment one bridge serves two. `hub_url` on the same record is what lets it: set it to the tenant's **public** Fly hostname, never `<app>.internal`, because only Fly Proxy starts a suspended Machine and a 6PN request reaches a hibernated tenant as a connection error rather than a wake. See `docs/plans/gateway.md`.
- A tenant can be created rather than declared: `apps/hub/src/host/fly-provision.ts`, `npm run machine -- create <app> <org> <image>`, which makes the app, the volume and the Machine. Every computer is the same computer, so the spec is three fields and the guest size, region, volume size and suspend behaviour are constants rather than settings. There is no `env` parameter, deliberately: Fly delivers app secrets as environment variables, so a setup code passed that way would boot fine and also read back out of `GET /machines/<id>`. `fly secrets set -a <app>` first, then create. Adding the tenant to `computersFromEnv` is still a code change, and stays one until there is a third tenant.
- The guest's PID 1 is `apps/hub/src/host/init.ts` (root, via `guest-entrypoint.sh`): it supervises desk-up, one `eve start` per roster Bot, the WhatsApp bridge and the hub with restart backoff and health probes, and mirrors their state to `/run/computer/status.json`, which `GET /healthz` reports. `npm run up` runs `host/eves.ts`, which supervises the same Eve children the same way (`superviseEves` in `host/eve.ts` is the one launcher); the desk and the hub are docker compose and the foreground process there, so it starts neither. The WhatsApp bridge child is opt-in behind `COMPUTER_WHATSAPP=on`: `repoRoot` used to resolve one level short, so `bridgeDir` was `apps/apps/whatsapp-bridge` and the `existsSync` guard silently skipped the bridge on every guest. Turn it on once it has been watched starting, because `/healthz` reports the supervisor's view and `fly.toml` health-checks the guest on it.
- Every bearer resolves to one `PrincipalRecord` (`apps/hub/src/service/principals.ts`) through one `verify()`: a `user` at a seat, a `bot` holding an agent token, a `service`. A role is a set of methods (`ROLE_METHODS` in `packages/shared`); `owner` is unrestricted inside the Seat service and every narrower role is an allowlist, so a new RPC reaches owners immediately and nobody else until listed. `Seat.Issue` hands a named subject a seat: an owner may issue any role, an `issuer` (what a control plane holds instead of the setup code) may never issue `owner` or `issuer`. A record with a `display` is bound to that screen whatever its role. `Seat.Revoke {}` ends the caller's seat; sign-out calls it. The Eve proxy and `/roster` are owner-only. Bots and connectors keep their own files and are adapted into a principal at verify time; `seats.json` keeps its name and still reads both older shapes (a bare string, and `kind: owner | guest`).
- A connector (`apps/hub/src/service/connectors.ts`, `connectors.json`) is the third door: `POST /connectors/<id>/<path>` with `x-connector-secret` forwards to the Bot's Eve at `/eve/v1/<kind>/<path>`. The WhatsApp bridge uses it on loopback, but nothing in the ingress requires that: it never looks at the peer address, so a bridge on another host reaches it at the tenant's public URL unchanged. Never accept a seat token there. A connector is inbound and hub-minted; a plugin is outbound and human-consented, so the two words never merge. `channel` still means eve's own route file (`apps/eve/lib/channels/*`, `agent/channels/` in a bot dir) and the product sense, and neither was renamed.
- A conversation holds the exchange, not a note that one happened. The connector ingress resolves the conversation, records the inbound message, and records the Bot's reply through `ConversationRegistry.recordDelivery`, which no-ops when the turn already spoke through `send_message` so the tool's record wins and the transport's copy is not written twice. It used to resolve the conversation and leave it at `seq: 0`, which is why a WhatsApp thread was invisible to every client.
- `data/policy.json` missing means the shipped defaults (`ask` on package installs, `rm -rf`, `curl | sh`, and git/npm/eve under `/workspace/eve`), not an open box; write `[]` to opt out. Those four regexes only catch what someone named, so with `AI_GATEWAY_API_KEY` set a fifth default rule sends every other shell call to **Auto Review** (`service/auto-review.ts`, run through the existing `check` seam). It is additive and cannot loosen the four: `evaluate` takes the strongest decision across matching rules, so an `allow` from the reviewer never overrules the `ask` on `rm -rf`. It is also the one default with `fail_open`, deliberately: it sits in front of every shell call, so failing closed would turn a gateway outage into a box where nothing runs.
- `prepare` runs `lefthook install` only inside a git checkout. Vercel builds from a snapshot with no `.git`, and lefthook exits 1 there, which fails the whole install; keep the guard.
- `apps/web` typecheck reads `.next/types`; a route you deleted can leave a stale reference until `rm -rf apps/web/.next && npx next build`.
- `apps/hub/test/eve-channel-auth.test.ts` is excluded from the hub tsconfig because it imports `apps/eve`; vitest still runs it.
- No Docker daemon in Claude Code on the web and similar sandboxes: `npm run up` uses the fake desk, and the desk image smoke test only runs in CI.
- **`fly deploy` builds from the working tree, so a local `eve build` breaks it.** `.dockerignore` must exclude `**/.output` as well as `**/.eve`: the guest image runs its own `eve build`, which renames any existing `.output` to a backup, and a local one copied into the context makes that rename EXDEV across the overlay and fails the image on the last step. Nothing catches it first: `.output` is git-ignored so a clean checkout never has one, and CI only runs hadolint over `deploy/fly/Dockerfile` (it builds the desk image, never the guest). Build it by hand before a deploy that matters: `docker build -f deploy/fly/Dockerfile -t expert-guest-verify .`

## Conventions

- Comments explain why, and the code around them is dense with them; match that density rather than adding what-comments.
- No em dashes in prose or comments; use commas, colons, or a new sentence.
- Errors on the wire are one envelope: `{ error: { code, message } }` with a code from `ErrorCode` in `packages/shared`. Throw `ComputerError`; anything else becomes a 500 `DAEMON_DOWN`.
- Secrets never land in `process.env` of a child the model can reach, in logs, or in an error message (see `ProvideSecret` in `apps/hub/src/service/voice.ts` for the pattern).
- Generated output under `packages/proto/gen` is committed; never hand-edit it.

## Do not commit

`data/` (roster and seat tokens), `.env`, `apps/web/.next`, `**/.eve`.

## References

- Deploying, and how to tell each step worked: `docs/DEPLOY.md`
- Audit and open findings: `docs/AUDIT.md`
- Grok Bot research, gap analysis, roadmap: `docs/GROK-BOT.md`
- WhatsApp parity plan (Vibey as one tenant, phases and todos): `docs/WHATSAPP-PARITY.md`
- System architecture, the seams, and the target shape: `docs/ARCHITECTURE.md`
- Conversations plan (one record for the model's voice, iOS and bot-to-bot): `docs/plans/conversations.md`
- Gateway plan (one always-on host for the WhatsApp sockets, tenants that suspend, Fly as the platform): `docs/plans/gateway.md`
- Design rationale and sources: `api/RESEARCH.md`; historical plan: `docs/history/`
- Eve project layout and adding a bot: `apps/eve/README.md`
