# Engineering audit

Date: 2026-09-02. Scope: the whole repository — `apps/hub`, `apps/web`, `apps/eve`, `apps/desk`, `deploy/`, `scripts/`, `packages/`, `api/`, and the docs. `apps/ios` was read for its API surface only; it was not built.

Method: every source file was read in full. Three independent reviews (hub, web, guest/deploy) were cross-checked against each other and against `api/DESIGN.md`. Baseline before changes: typecheck, 175 hub tests, layer lint, proto check and the Next build all passed. This document records what was found, what this pass fixed, and what is still open, ranked.

## Summary

The codebase is small, well-commented and mostly coherent, and the core contract (one `computer` tool with a closed action union, pixel coordinates, a seat FSM per screen, view-only VNC with input through the hub) is sound and better argued than most of what it copies. The problems were of three kinds:

1. **Dead and contradictory surface.** Two agent harnesses (the hub's own OpenAI loop and Eve), a Fly "edge" process that was never deployed, a debug page, a static-panel path, an adapter module reachable only from tests, and three planning documents that disagreed with the code and each other. The README described idle-suspend and cold status reads that do not exist in production.
2. **A handful of real correctness holes in the hub.** Idempotent `request_id` was not atomic (an overlapping retry double-clicked); validation ran per action after earlier actions had executed; a human taking the seat did not stop a running batch; shell timeouts killed the `docker exec` client, not the process; pixel tokens were not bound to their display; `Pair` had no lockout; `ProvideSecret` could be replayed.
3. **Product-level security posture.** Every signed-in user of hello.expert shares one machine and becomes its owner; sign-up was open; on the Fly guest the model's shell inherits the hub's environment and can read every token on the volume.

Categories 1 and 2 are fixed in this pass. Category 3 is partly mitigated (email allowlist, scrubbed shell environment, secrets hardening) and the rest is the top of the open list.

## What this pass changed

### Removed

| Removed | Why |
|---|---|
| `apps/hub/src/service/chat.ts`, `handler/chat.ts`, `/chat` route and tests | A second agent harness (OpenAI tool loop) that no client called. Eve is the harness. |
| `apps/hub/src/host/edge.ts`, `edge-cli.ts`, `deploy/fly/edge-entrypoint.sh`, `edge.test.ts` | The always-on edge / idle-suspend process. Not in `fly.toml`, never ran; its proxy could not carry WebSockets anyway. |
| `apps/hub/src/service/adapters.ts` + test | OpenAI/Claude/Gemini action adapters with no route. The mapping rules stay in `api/RESEARCH.md`. |
| `apps/hub/src/static/debug.html`, the `webDir` static-panel path, `COMPUTER_WEB_DIR` | The hub no longer serves a panel; the product web is Vercel. |
| `api/types.ts` | A stale third copy of the types. `packages/shared/src/index.ts` is the one source. |
| `apps/eve/bots/night/**`, `apps/eve/.vercelignore`, `@ai-sdk/openai` | A degraded copy of `main` with weaker safety instructions, built into the image; an ignore file for a package that is not a Vercel app; a dependency imported nowhere. |
| `apps/web/components/pair-view.tsx`, `login-gate.tsx`, `hero-headline.tsx`, `app/app/page.tsx`, `vercel.json`, `loadSeat`/`saveSeat`/`screenSrc`/`defaultHubUrl`/`pair()` | Unreachable or one-line wrappers; a duplicate route. |
| Unused exports: `verifyVncUpgrade`, `PixelRegistry.reuse/novncPort/rfbPort`, `withSeatToken`, `issueSeatToken`, `VoiceService.subscribe`, `asRequestId`, `PACKAGE`, `assertInBounds`, empty branches in `router.ts` and `computer.ts` | Dead. |
| `plan.md`, `plan-notes.md` (moved to `docs/history/` with a banner) | Historical; contradicted the code on Next/Vercel/Fly, TigerVNC, workspaces, the shell approval gate. |

### Fixed in the hub

- **Idempotency is atomic.** `ComputerService` and `FileService` store the in-flight promise under `request_id` before the batch starts; an overlapping retry waits for it. Batches that never started (`SEAT_HELD`, `DAEMON_DOWN`) are not cached. Caches are bounded (256 entries) instead of growing forever with base64 screenshots.
- **Validate the whole batch before running any of it.** Limits from `spec.json` (wait ≤ 8000, keys ≤ 5, text ≤ 4000, scroll ±20, drag 2–32, integer coordinates) are checked up front; a violation is a 400 for the request and nothing touches the box, so the id can be reused with a fixed body. Previously action 3 could fail validation after actions 1–2 had run under an id that could never be retried.
- **A human taking the seat stops a running batch** at its next action (`skipped: seat_taken`). Previously `requireAgent()` ran once per batch, and a 160-second batch kept clicking after `SetPresence(true)`.
- **Shell timeouts kill the workload.** `timeout -s KILL` wraps the command inside the box; the hub's own deadline is slightly longer. Output is capped as it arrives (200 kB per stream) rather than buffered whole.
- **The `local` transport no longer hands the model the hub's environment.** The spawned shell gets `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `DISPLAY` and nothing else. Before, `shell {argv:["env"]}` on the Fly guest returned every token and key the guest was started with.
- **Pixel tokens are bound to their display** on the websockify upgrade. A 15-minute token for `:2` can no longer open `:1`.
- **`Pair` locks for a minute after ten wrong codes.** JSON bodies are capped at 1 MB.
- **`ProvideSecret` works once per request** (`CONFLICT` on replay).
- **`readFile`/`writeFile` classify a dead box as `DAEMON_DOWN`** with the retryable detail, not `VALIDATION`.
- **`createHub` no longer throws on a fresh box when `COMPUTER_EVE_URL` is set**, and Eve URLs are resolved per request so Bots created after boot are routed.
- **`Seat.Pointer` takes the spec shape only** (`type` required; scroll notches capped ±20); the half-parsed proto-style bodies that turned a right click into a left click are gone. `Seat.Type` is capped at 4000 chars like the model's `type`.
- Static serving checks `isFile()` (no EISDIR 500s) and requires a path-separator prefix; the hub handles SIGTERM.

### Fixed in the web app

- **Sign-up can be restricted** with `AUTH_ALLOWED_EMAILS` (database hook plus OTP gate). Unset keeps the previous open behaviour and logs a warning in production.
- **Production refuses to start without `BETTER_AUTH_SECRET`** and without `RESEND_API_KEY` (which otherwise printed every login code into the Vercel logs). `https://*.vercel.app` and the hub origin are no longer trusted origins.
- **Agent-supplied URLs are protocol-allowlisted** before landing in `href`/`src` (`javascript:` attachment = click-to-XSS with the seat token behind it).
- **The noVNC iframe is sandboxed** (`allow-scripts`, `referrerPolicy="no-referrer"`); security headers (`nosniff`, `X-Frame-Options`, HSTS, referrer and permissions policies) are set in `next.config.ts`.
- **Reconnect actually reconnects**: the response from `/api/computer/reconnect` feeds the workspace instead of a `getSession()` call that never refreshed the store. Auth failure is detected by error code, not a regex on the message.
- **Input hook**: the left button is recorded as held only after the box acknowledges the move (a failed release used to leave the button down for good); `deltaMode` is honoured (Firefox line-mode wheels scrolled nothing); only a primary left-button release ends a drag.
- Refs are written in effects, not during render, so the React Compiler can compile `ChatPane`, `useSeatInput` and `DesktopPane`; the held VNC URL is derived with state.
- `error.tsx` and `not-found.tsx` boundaries; per-page canonical instead of a root-wide `/`; valid list markup on the marketing page; `aria-live` on the chat log and `role="status"`/`alert` on seat state; the invisible bot id on the "not running" message; the `KeyboardBar` moved to its own file; the Fly URL and slash-trimming in one place; brand name in one place.

### Fixed in the guest, deploy and scripts

- **`tini` is PID 1** in both images; the compose entrypoint traps SIGTERM and stops windows so Chromium releases its profile lock; `stop_grace_period: 30s`.
- **`start-window` verifies Xvfb answers** (`xdpyinfo`) before starting x11vnc/Chromium and exits non-zero if it does not; an empty owner no longer erases an existing claim; `umask` is scoped. **`stop-window` terminates Chromium** for that profile (it did not exit with its X server and kept `SingletonLock`), and takes the lock in a subshell.
- **The apt list is one file** (`apps/desk/packages.txt`) read by both Dockerfiles; `scrot` and `xterm` dropped. The Fly image no longer builds the Next.js app or the `night` bot, installs as `box` with `--chown` (no doubled `chown -R` layer), copies only `node` and `npm`, and the entrypoint chowns only `/workspace` and `.computer` rather than the whole volume on every boot. `.dockerignore` uses `**/` patterns and excludes `apps/web`, `apps/ios`, the Swift codegen.
- `guest-entrypoint.sh` warns loudly when the setup code is not a Fly secret.
- `scripts/computer.mjs`: a Docker daemon that was down once no longer leaves `.env` on the fake desk forever; the CLI pairs once and keeps its seat token (each `bot` command used to mint a permanent one); a second `up` no longer double-starts Eve on `:2000`; `.env` keys with digits survive; non-JSON hub errors are readable.
- `lint-layers` matches path segments (no false positive on `error-handler.ts`) and also forbids `desk → service`; `proto-check` diffs against `HEAD` so staged drift is caught.
- `apps/eve`: `allowImportingTsExtensions` (typecheck was failing with five errors and was not in the root script); the `computer` tool schema is a discriminated union with the real field limits instead of `catchall(unknown)`; `hubRpc` has a timeout and survives non-JSON responses.
- **Toolchain**: `npm run typecheck` covers every workspace; `oxlint` (correctness rules as errors) runs in `npm run lint`; `npm run check` runs everything; `.github/workflows/ci.yml` runs typecheck, lint, tests, proto check, the Next build, `shellcheck` on the scripts, `hadolint` on both Dockerfiles, and boots the desk image to assert a 1280×800 PNG screenshot. `@types/node` is 24 everywhere; cloud-init installs Node 24.

### Docs

`api/DESIGN.md` now describes the five tools, the voice (`SendMessage`, `Occurrences`, `ProvideSecret`), `DENIED` 403, the wire shape, validate-before-run, `seat_taken`, pixel-token binding and the `Pair` lockout. `README.md` no longer claims per-account machines, idle suspend, cold status reads, `~/.config` persistence on Fly, or a `packages.txt` the agent is told to call `packages.md`. `api/RESEARCH.md` is corrected on pixel-token rotation and the Fly volume.

## Open findings, ranked

### P0 — product security

1. **One computer for every account.** `apps/web/lib/computer-seat.ts` pairs every user with the single hub using the single setup code, and the hub treats every paired seat as the box owner (`CreateBot`, `DeleteBot`, clipboard read, `ProvideSecret`, the Eve thread). The marketing copy promises "your" computer. `AUTH_ALLOWED_EMAILS` makes a private deployment safe; a public one needs one machine per account (Fly Machine per user, or at least a seat token that cannot provision) before anyone else signs up. See the roadmap in `docs/GROK-BOT.md`.
2. **Secrets on the Fly volume are readable by the model.** The roster (`bots.json`), `seats.json`, `eve-secret` and the minted `setup-code` live under `/workspace/.computer`, owned by `box`, and every `shell`/`read_file` runs as `box`. The scrubbed environment closes the `env` leak; the files remain. Fix: run the hub as its own UID owning `/workspace/.computer` at 0700, hand Eve its token through a per-bot 0400 file or an inherited fd, and require `COMPUTER_SETUP_CODE` as a Fly secret (the entrypoint now warns, not refuses).
3. **No token revocation or expiry.** Seat tokens are permanent, appended to `seats.json` forever, and never revoked on sign-out (`apps/hub/src/handler/auth.ts`, `apps/web/app-shell.tsx`). `/api/computer/reconnect` lets any signed-in user mint more. Needed: `Seat.Revoke`, expiry on seat tokens, revoke on sign-out, and a bot-token rotate path.

### P1 — correctness and product

4. **The voice is written but never read.** `Agent.SendMessage` writes occurrences into `/workspace/.bots/<id>/transcript.jsonl`, but neither the web client nor iOS reads `Seat.Occurrences`, answers a widget, or calls `ProvideSecret`; the web renders Eve's raw assistant text instead. So the "only `send_message` reaches the human" contract from `api/RESEARCH.md` is not what the product does, and there is no `AnswerWidget` RPC at all. Decide: render the occurrence log in the clients (Grok's behaviour) or drop the voice subsystem and use Eve's native input-request protocol, which the web already renders. Do not keep both.
5. **Nothing supervises the children.** Eve processes are spawned detached and unref'd (`apps/hub/src/host/start-eves.ts`); if one dies, `/eve/v1` returns `DAEMON_DOWN` until the Machine restarts. `tini` reaps but does not restart. `/healthz` returns `ok` unconditionally, so a Machine with no X server is "healthy". Needed: a supervisor (s6 or a small restart loop with backoff) and a health check that probes the primary display and each Eve port.
6. **Scheduled runs skip the shell approval gate** (`apps/eve/lib/tools/shell.ts`), and the daily schedule invites the model to reinstall packages and clear caches unattended. Ship a default `data/policy.json` that at least `ask`s on `apt`, `rm -rf`, `curl | sh`, or drop the exemption.
7. **`type` clobbers the clipboard and `ctrl+v` is not paste in a terminal** (`apps/hub/src/desk/docker.ts`). Anything the human types through `Seat.Type`, passwords included, is then readable by any seat holder via `ClipboardGet`. `xdotool type` for ASCII with the clipboard only as the unicode fallback would remove most of the exposure.
8. **A failed transcript restore resets `seq` to 0** (`apps/hub/src/service/provision.ts`), so a client holding a cursor sees nothing until that many new bubbles exist. Persist the last `seq` beside the roster.
9. **Cross-Bot transcript forgery.** Any Bot can `write_file` another Bot's `transcript.jsonl`, and `VoiceService.restore` trusts every line, including `turnEnded`. Accepted by "Bots are not security boundaries", but the transcript is described as the human's record; it should at least be validated on load.
10. **`Pair` is still unauthenticated with CORS `*`.** The lockout stops online guessing; a body-cap exists; but a permanent owner credential from one correct guess is a lot. Tie the setup code to a one-time use (rotate after pairing) or make Pair a web-server-only path.

### P2 — quality

11. **The proto is not the wire.** `computer.proto` uses `oneof` actions, `bytes` images and enum states; the hub speaks a hand-rolled JSON shape (`{type:"click"}`, `screenshot_b64`, `"AGENT"`). A buf-generated client cannot talk to this hub; the Swift codegen is committed and unused. Either generate real Connect handlers from the proto or demote it to documentation and stop generating.
12. **`customSession` runs the hub Pair inside every session read** (`apps/web/lib/auth.ts`). A new user's first `/login` render waits up to 15 s on the hub. Move pairing to an explicit, cached endpoint.
13. **Better Auth rate limiting is in-memory per lambda** on Vercel; set `rateLimit.storage: "database"` (needs the `rateLimit` table in the generated schema).
14. **Chat session cursors are per bot, not per user** (`apps/web/lib/storage.ts`), so a shared browser resumes the previous person's thread.
15. **`apps/hub/test/eve-channel-auth.test.ts` is excluded from the hub tsconfig** and typechecked nowhere. `EVE_HUB_SECRET_HEADER` is defined twice (`apps/eve/lib/auth.ts`, `apps/hub/src/host/eve.ts`).
16. **No tests for `DockerDesk`** (argv construction, `shellQuote`, `put`, timeout, `classifyDeskFailure`), for the Pair lockout window, for `Occurrences` paging across a restart, or for the web app at all.
17. **`fly.toml`**: `strategy = "immediate"` makes every deploy a hard restart; no swap for a 4 GB box running Chromium and Node ×3; `hard_limit = 40` requests counts each noVNC socket and Eve stream. No backup/restore runbook for the single volume.
18. **`skills/expert/SKILL.md` and its tarball hard-code `https://mblode-computer.fly.dev`**, and nothing regenerates the tarball from the source file.
19. **Mobile layout** of `apps/web`: a fixed 20 rem chat row under the desk, `h-full` that ignores the keyboard, no tab switcher, pinch zooms the page.
20. **`Reveal` renders children at `opacity: 0` on the server** and ignores `prefers-reduced-motion`.

## Verification

After the changes: `npm run check` (typecheck for six workspaces, layer lint, oxlint, 163 hub tests, proto check) passes, and `next build` completes with no warnings other than Better Auth's base-URL notice at build time. The Fly and desk images and the desk smoke test were not built here (no Docker daemon in this environment); CI does that.
