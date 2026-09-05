# WhatsApp assistant execution notes

## Status

Implementation is authorized. The changes below are implemented locally and
verified. The whole seven-slice plan is not complete. The Railway gateway and
persistent clock have been deployed; Blode deployment is in progress. No paid
coding job has been dispatched.

## Implemented

- Authenticated `/work` breakouts for the computer, coding sessions and plugin
  setup. Links retain the selected assistant and conversation through login,
  contain no credential, and refuse the wrong signed-in computer.
- Coding launch UI with original-request context, account-scoped retry identities
  retained across page reloads without storing the brief, partial refresh recovery,
  provider links and PR links for conversational review.
- Owner-bound coding dispatch through the existing `send_message` tool, restricted
  to explicitly enabled repositories. Provider identities persist before launch;
  retries reconcile the same identity and reject changed briefs.
- Independent coding polling with persisted next-check times and error backoff
  from one to fifteen minutes. Completion returns through the original owner's
  conversation even when the coding page is closed.
- Durable inbound receipts and an independent WhatsApp sender. The PA route
  acknowledges acceptance with HTTP 202 after registering a persistent wake.
  Concurrent retries execute once. Interrupted effects are reported as uncertain,
  never silently rerun. Legacy groups retain their synchronous path.
- Persistent bridge send receipts bind the recipient and content. A previously
  uncertain send is not retried as a new send or labelled successful.
- One recorded reply for the modern WhatsApp path. Recorded tool messages take
  precedence over private final prose and use shared outbound redaction. Delivery
  confirmation is persisted before its wake registration is cancelled.
- Persisted turn capabilities with renewal available only to the trusted driver.
  Startup fails closed on misplaced workflow state and preserves the old files.
- Actual Eve conversation continuation, serialized per account and chat. Every
  shipped Bot and the template load runtime instructions at each turn boundary.
- Versioned instructions, memories and bounded procedures, with compare-and-swap
  edits and undo. Owner seats can inspect and edit them in settings; verified PA
  owner turns can edit them through `send_message`. The next turn reads the
  hub-owned revision. Source-file edits do not claim runtime activation.
- Persistent clock registrations for leases and due checks, with tenant-specific
  credentials and configured wake destinations. A due check remains due across
  clock downtime until advanced or cancelled. Deployment configuration now names
  the required clock volume; it has not been provisioned.

## Verification

- Root `npm run check`: all workspace typechecks, layer lint, formatting, knip,
  hub tests (397), web tests (102), Eve tests (94), bridge tests, clock tests and
  the real runtime fixture passed. The final `proto:check` failed solely because
  it compares generated output with committed HEAD and these edits are uncommitted.
- Both proto sources are byte-identical. A fresh generation reproduced all
  generated files byte for byte, including the Swift service descriptor.
- Production Next.js build passed with `/work` and the new settings UI.
- `npm run test:runtime` builds installed Eve with a deterministic model and the
  production WhatsApp channel and instruction reader. It proves current-turn
  selection, account isolation, instruction reload and conversation continuity
  after an Eve restart. No external model call is used. It runs in the same root
  check locally and in CI.
- The real HTTP hub fixture proves acceptance before completion, an asynchronous
  acknowledgement, canonical result delivery and duplicate ingress suppression.
- Deliberately invalid tests cover mismatched retries, wrong owner/role, stale
  revisions, malformed procedures, swapped workflow paths, uncertain sends and
  cross-tenant wake registration. Corrected inputs pass those same boundaries.
- A focused outbound test additionally verifies redaction of coding and clock
  credentials after the umbrella run.

## Remaining work and external gates

1. Existing gateway integration: on 2026-09-05 the user identified `61456455551`.
   Read-only Railway inspection confirmed `EXPERT_DM_JIDS=+61456455551`,
   `EXPERT_URL=https://mblode-computer.fly.dev`, connector `whatsapp`, and a
   configured connector secret on `vcmc-bridge` in production. Reuse the existing
   `../vcmc-agent/bridge` gateway. Its routing code sends selected owner DMs to
   Expert and keeps groups and other member DMs with Vibey. This proves configured
   routing, not an end-to-end delivery test or the new PA owner binding. The legacy
   payload lacks `acct` and `messageId`, and its owner matcher accepts phone
   suffixes. Adapt durable ingress, exact owner identity and asynchronous delivery
   before enabling PA mode; do not weaken the owner gate or provision a second
   WhatsApp socket. A test GitHub repository remains unspecified.
2. Clock migration completed: `clock_data` volume `vol_r68dl2nxmpjmxpn4` is
   attached to the single running writer `080e396be7d998`. A real authenticated
   due registration survived restart and woke Blode successfully (HTTP 200). The
   test registration was cancelled. This proves wake persistence, not dynamic
   user routine execution, which is the separate remaining slice below.
3. Dynamic routine definitions, activation revisions, cancellation, time zones,
   missed-run policy and their execution driver remain unimplemented. Persistent
   due checks are the shared foundation, not a claim that this slice is finished.
4. Dynamic plugin activation and actual OAuth/static-credential setup remain
   unimplemented. The current plugin form saves source configuration and accurately
   says credentials and runtime activation are separate. It does not connect an
   account. No real plugin provider was consented during this run.
5. Conversation-first work overview, precise WhatsApp approval/quoted-reply
   continuation, and artifact/voice-note acceptance cases still need completion.
   Coding review currently continues through the authenticated provider link.
6. Real phone takeover, provider launch reconciliation, Fly suspend/restart tests
   and the seven-day pilot have not been run. Local fixtures are not those proofs.

## Architecture accounting

Deepen and Harden modes extend the existing hub, bridge, Eve runtime and clock.
No new deployable service, framework, database or queue dependency was introduced.
The core model surface still has five tools. Structured `send_message` operations
reuse its existing turn identity and authorization boundary.

Shared memory parsing replaces duplicate representations. Shared outbound
formatting gives the hub and Eve the same sanitization. Persistent send receipts
replace the former in-memory sent-key set. The workflow-state check replaces a
warning-and-continue branch. Routine wake work extends the existing clock.

The necessary new modules own distinct durable lifecycles: inbound receipts,
outbound receipts, coding launch identities, approved revisions and clock
registrations. Compatibility remains for legacy traffic without stable request
identities. Procedures are bounded inline instructions, avoiding a second loader
and additional model tool until evidence requires them.

No recipe was added, so the skill's fresh-agent recipe verification does not
apply. Enforceable guarantees are tested through existing local/CI gates; live
provider semantics, OAuth consent and Fly persistence remain explicit gates,
not guarantees inferred from types or mocked tests.


## Gateway rollout, 2026-09-05

- `../vcmc-agent/bridge` now forwards stable message IDs, account `vcmc` and
  transport-verified canonical owner phone identity. A suffix or opaque LID cannot
  become an owner phone. The new connector `whatsapp-vcmc` targets `main`; the
  original `whatsapp` connector remains available for rollback.
- Blode's separate delivery credential permits only `/send?acct=vcmc` to the exact
  configured owner with an idempotency key. It cannot read community history,
  membership or pairing state. Send receipts survive Railway restarts.
- Bridge typecheck, scoped lint and all 208 bridge tests passed. Guest image build
  passed after replacing an invalid per-workspace node_modules guard with a check
  of npm's actual workspace symlink. Supervisor tests pass with the clock secret
  excluded from model children and hub-only credentials restored only to the hub.
- Railway deployment `6325f48c-2422-436b-9a71-f5d9e6bd3d5a` is successful.
