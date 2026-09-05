# One assistant, a computer, and work that comes back

Status: implementation authorized on 2026-09-05. Authenticated breakouts, durable WhatsApp delivery, coding dispatch and polling, and versioned runtime configuration are implemented locally. The full assistant roadmap remains incomplete. See [execution notes](whatsapp-personal-assistant.notes.md) for verified changes, limitations and remaining slices. [Research and source limitations](assistant-user-research.md).

## Outcome and scope

Expert is one personal assistant you can text or voice-message on WhatsApp. It can use its persistent computer, let you take control from your phone, delegate repository work to a cloud coding session, remember corrections, and maintain instructions, skills and routines through conversation. It returns a short outcome with evidence instead of a long transcript.

Matt explicitly requested WhatsApp, phone computer access, coding sessions, and self-updating memory/instructions/routines/skills. He questioned the usefulness of multiple personalities. Therefore the recommendation is one default assistant with distinct tasks, not a mandatory team setup. Existing bots, histories and group behavior remain available; no destructive consolidation is part of this plan.

Pilot route: reuse Matt's existing Blode computer and the Railway gateway in `../vcmc-agent`. The user identified `61456455551`; live configuration confirms its DMs are selected for the Blode `whatsapp` connector. The legacy bridge still needs adaptation to the durable PA contract and exact owner binding, as recorded in the execution notes. Public signup, billing, providing phone numbers, and a new WhatsApp provider remain outside the pilot.

## Product decisions

1. **One relationship, many tasks.** The WhatsApp contact is stable. Each substantial job has a task ID, title, original request, status, result and evidence. Replying to a task message targets that task; an ambiguous follow-up gets one short clarification. Do not pour unrelated tasks into an unlimited shared context.
2. **WhatsApp for daily interaction; web for depth.** Text, voice notes, progress, routine changes and concise outcomes stay in WhatsApp. Computer control, account consent, exact previews and rich files open on hello.expert with the same task selected.
3. **The computer is an escape hatch and a work surface.** Prefer available APIs/connectors for suitable operations. Keep the signed-in browser for gaps, inspection and human login. No new desktop implementation is needed.
4. **Delegation has visible evidence.** Coding returns a provider session link, repository/branch, PR when present, and checks actually reported. A provider saying complete is not proof tests passed or a PR merged.
5. **Self-updating means effective, inspectable, reversible changes.** A correction must change a later real turn, survive redeploy and be undoable. Writing an unused Markdown file does not count.
6. **Behavior changes cannot grant authority.** Memory and skills cannot edit credential access, sender ownership, repository allowlists or policy. Those are control-plane state.
7. **One accountable voice.** The hub's message records and delivery states are authoritative. The channel cannot both post final model text and independently post send_message results.
8. **Short output with a place to inspect.** Normally one acknowledgement, material progress or a blocker, and one result. Keep routine no-ops quiet. The web shows a task timeline, not hidden chain-of-thought.

The research supports these as design hypotheses, not measured superiority over competitors. Earlier memory notes also favored consolidating overlapping roles; this plan follows the current explicit request rather than treating that older inventory as current.

## What exists and what is missing

Code inspected in this checkout on 2026-09-05. Existing tests were read, not run; no live deployment claims are made.

| Capability          | Verified existing code                                                                                       | Required work                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Persistent computer | Hub/desk layers, per-account machines, wake supervision and volume-backed state.                             | Real restart/redeploy verification for active and parked work; do not rely on a symlink warning.                                |
| Phone computer      | desktop-pane, invite-desk, use-desk-touch, desk-view: touch/trackpad, zoom, scrolling and keyboard handling. | Owner-authenticated task links, hand-back continuity and real-phone QA.                                                         |
| WhatsApp            | Linking UI; account-scoped bridge auth; DM/group routing; queues, retries, media and voice transcription.    | Owner-only PA setup, durable inbound acceptance, task continuation and one outbound lifecycle.                                  |
| Conversations       | ConversationRegistry JSONL records, route binding, cursors and delivery deduplication.                       | Durable task/run and transport state associated with those records; web inspection of the actual WhatsApp exchange.             |
| Memory/profile      | BotState seeds persistent files and formats memory/profile into prompt text.                                 | No production call to BotState.prompt was found. Connect it to actual turns and reconcile main's separate notes.md instruction. |
| Instructions/skills | Shipped static bot directories; installed Eve supports dynamic instruction and skill definitions.            | Runtime data resolution, versioning, validation, provenance and undo without rebuilding.                                        |
| Routines            | Shipped Eve schedules, hub wake alarm and an outside clock.                                                  | User-defined schedules, timezone, run history, test-run, effective cancellation and runtime schedule propagation to the clock.  |
| Coding              | CodingService.start/refresh and Seat RPCs, with provider/run/PR references.                                  | WhatsApp-authorized dispatch, stable launch identity, autonomous refresh and completion back to the original task.              |
| Approvals           | Hub policy ask/deny rules, conversation widgets, Eve approval UI, scoped seats.                              | One action-bound approval/resume lifecycle. A generic yes must not authorize an unrelated action.                               |

Load-bearing corrections:

- whatsapp.ts explicitly creates a fresh continuation token for every inbound message to avoid old turn replay. Removing the random suffix alone is incorrect.
- send_message appends through the hub, while ordinary WhatsApp replies come from synchronous final-text extraction. They are not yet one delivery path.
- FileService.writeFile writes workspace files without PolicyService evaluation; shell can also write. A model-writable config file cannot serve as an enforceable approved state.
- dm_policy defaults to members, with a fail-open preloaded-membership state. owner_jids is currently a proactive-send list, not a proven inbound owner identity. Tolerant number matching cannot establish approval authority.
- Coding RPCs are explicitly Seat-only today. Assistant-initiated coding is a deliberate contract extension.
- Invites target display 1. senderHash alone does not authenticate a browser recipient. The one-assistant pilot fits screen 1, but ownership still needs verification.
- Workflow state is intended to persist through a volume symlink; init currently only warns if it cannot establish that. Accepted background work must not silently fall back to ephemeral state.
- TurnService currently stores tokens in an in-memory Map with a 150-second lifetime. Persisting task messages alone cannot make a later send or restarted action authorized.

## First complete demonstration

From the owner's WhatsApp, ask the assistant to collect information from a test site requiring login. It acknowledges only after durable acceptance. Open its computer on a phone, sign in without putting credentials in chat, then hand control back and close the browser. It finishes and delivers one concise result with evidence to the original DM. A follow-up referring to that result continues the correct task.

Then demonstrate two extensions on the same foundation:

- Correct a preference, save a repeatable procedure, schedule it in Australia/Melbourne, suspend/restart the computer, and receive the next result with the correction applied.
- Ask for a small change in an explicitly configured test repository. One cloud coding session starts; closing the browser or retrying the inbound does not launch another. The PR and work link return to the originating WhatsApp task.

Do not bundle all three into the first PR. Each slice below has a separately demonstrable outcome.

## Shared implementation decisions

### Durable task, message and action identity

Extend the existing hub-owned conversation persistence with task state, rather than adding a new agent framework or duplicate transcript. A task references a conversation; a provider run references a task. Store stable inbound identity from the authenticated account plus provider message ID, with a content hash that rejects conflicting reuse. Do not deduplicate by message text.

Separate these states:

- Task: accepted, running, waiting_for_owner, complete, failed, cancelled.
- Outbound delivery: pending, provider_accepted, confirmed when available, failed, uncertain.
- Action: proposed, authorized, executing, succeeded, failed, uncertain.

Use persisted events/state transitions, atomic writes and one in-process owner per task. A restart reconstructs unfinished work. An expired execution lease does not prove an external action failed. Reconcile ambiguous operations before retrying; arbitrary browser actions cannot promise exactly-once execution.

Persist the authorization binding for each accepted task/run separately from its short-lived transport token: tenant, verified owner, bot, conversation, allowed operations and revocation/version. A trusted execution worker reissues or renews a bounded capability for that persisted active run and supplies it through Eve auth metadata. The model cannot select a task, mint a capability, or extend its own authority. Recheck cancellation and revoked owner grants before renewal and dispatch. An expired header is never repaired by accepting a model-supplied conversation ID or falling back to the bot's seat thread. Test send/approval after more than 150 seconds and after hub restart, plus cross-bot use and revocation while parked.

The bridge acknowledges accepted inbound work promptly; processing no longer lives inside its HTTP response. The existing send_message voice creates outbound records that a delivery worker sends through the bridge. Record provider IDs where available. A send timeout after provider acceptance becomes uncertain, not automatic resend. Test duplicate inbound before/after restart and the outbound acknowledgement-loss window.

Turn continuation must select events belonging to the current turn, not the first historical turn.completed. Test follow-ups, queued messages and recovery against the installed Eve runtime before deleting the fresh-session workaround. An event-stream cursor or explicit run identity is required.

### Owner authority and the model surface

Create a verified binding between the signed-in account, computer and WhatsApp sender. For the pilot, use authenticated web pairing plus a short-lived DM challenge to prove the intended owner's phone/JID. Challenges do not themselves grant a seat. New PA accounts fail closed until bound; a group member or a familiar-looking number is not an owner. Migrate legacy accounts through an explicit PA mode, not a global default change.

Preserve five core model tool names. Proposed narrow extension: add a distinct structured action occurrence to send_message for coding launches and configuration/routine changes. It carries a closed operation schema, not a generic RPC. The hub binds the proposal to the current authenticated turn, validates it, and dispatches only named operations. An already-authorized action is not a widget and does not end the turn or require fictional human input. If new consent is needed, the host creates a separate genuine approval widget that ends the turn until the owner answers. Record action outcomes separately from consent. There is no arbitrary RPC name, executable code payload or seat token in the model surface. Update api/DESIGN.md, api/spec.json, packages/shared and both proto copies together where the wire changes.

Within an owner's already-granted operation/repository scope, a direct request can proceed without another confirmation. New recipients, repository scope, ongoing schedules or authority changes require an exact preview and an owner decision. An approval binds task, operation, payload hash, actor and expiry; it is consumed once. Edits invalidate it. Prefer an authenticated web card for the initial pilot rather than assuming free-text yes provides enough evidence. Status, acknowledgements and replies to the requesting owner do not require repeated approval.

Existing whatsapp_send and expert_invite exceed the simplified five-tool description. Consolidate their transport/invite behavior into host-owned delivery and typed UI occurrences as their replacements ship; keep legacy compatibility until callers move. Do not silently remove them before those paths work.

This is not a promise that every semantic send through a signed-in browser can be recognized and blocked. Shell/network access and browser credentials remain broad capabilities within a tenant. For a relatively secure pilot, use test/draft-capable accounts and narrow connected-app grants; do not market complete action-level enforcement over arbitrary GUI operations.

### Runtime memory, instructions and skills

Use installed Eve dynamic resolvers at a verified turn boundary. Resolve one version snapshot per turn so a mid-turn edit does not unpredictably change the instructions in flight. Test that the actual model context reflects the snapshot, not only a formatter helper.

Reuse BotState and the current persistent memory directory. Import or explicitly link the legacy /workspace/notes.md once; record migration identity to prevent repeated duplication. Keep original content until verified. No vector database is justified by the current small memory model.

Authoritative active behavior lives in hub-owned versioned storage, with a read-only model-visible snapshot and ordinary task files remaining on /workspace. Changes go through the authenticated action path; editing a snapshot or a staging file with shell/write_file cannot activate it. Hub code supplies the active validated snapshot through a dedicated read-only, assistant-scoped capability. Eve runs as box, so its loader and any credential it holds are model-shell-readable; neither is a private host boundary. That capability must grant no mutation, promotion, approval or authority operations. A box-writable projection is never the authoritative source. No owner/setup credential enters Eve.

Represent memory facts, editable instructions and Markdown skills separately. Each change has version, source task/message, actor, timestamp and prior version. Owner corrections apply immediately within scope. The assistant may record relevant facts under the owner's learning policy; inferred behavioral changes are proposed, not silently activated. No secrets in memory. Malformed or oversized data keeps the last good version and produces one actionable failure.

Keep immutable platform rules outside editable instructions. Skills are procedures, not new executable tools or credential grants. An undo creates a new version restoring previous content. It does not undo external actions. Clear/forget removes a fact from subsequent prompts and records the operation; explain retention of prior audit versions rather than promising secure erasure.

### Routines and work while the computer sleeps

User routines are data: ID, instruction/skill reference, IANA timezone, validated schedule, enabled state, destination, configuration version, next occurrence and run history. Show the next local run when creating or editing. Test-run does not enable a schedule or bypass action policy.

Reuse the current shared cron semantics and installed scheduling support. Enumerate local calendar minutes into UTC instants using supported timezone APIs and the shared matcher. Unsupported expressions are rejected. For the initial contract: a nonexistent DST local minute is skipped; a repeated local minute runs once, with the UTC instant recorded. Verify both cases.

A routine run is identified by routine ID and occurrence, with a snapshot of its then-active version. Pausing prevents future unaccepted runs; it does not cancel a running side effect. Cancelling the current task is a separate action. At recovery, catch up at most the newest missed occurrence within 15 minutes; older ones are marked missed. Three consecutive execution failures pause that routine and notify once. Delivery retries do not rerun the work.

Dynamic routines cannot rely on the clock's compiled manifests. Extend the existing outside clock with a minimal durable per-tenant next-wake record and revision. A hub-only authenticated registration sends timestamps and tenant identity, not prompts, phone numbers or credentials. The clock persists before acknowledging. The hub retains/retries its pending publication; routine activation remains visibly pending until registration succeeds. Clock targets come from its configured tenant allowlist, never arbitrary request URLs. Lower revisions cannot restore a cancelled schedule.

The clock still only wakes public tenant URLs; it does not execute tools or hold provider keys. The hub owns due-run creation and busy markers. Clock restart must preserve registered wakes. Keep shipped schedules as a compatibility path until migrated, with only one dispatcher active per routine. Adding this capability is a guest-and-clock deploy, including durable clock storage.

### Coding through the existing provider

Reuse CodingService and Cursor for the pilot; no local coding harness, provider registry or Claude Code/Nex integration in this scope. Model choice in a provider is not permission to run a local CLI.

Persist a launch intent and stable client-supplied bc-UUID before POST /v1/agents. Cursor documents agentId conflict semantics: on timeout or 409, retrieve and reconcile that same ID instead of starting another. Restrict repository/ref to the owner's configured scope. Do not copy box credentials, private browser sessions or unrelated conversation history to the coding provider. Send the task brief and selected context deliberately.

Current Cursor v1 docs say webhooks are forthcoming, so use a hub-owned polling worker with persisted next-check time, bounded backoff, and restart recovery. Slice 03 introduces the minimal next-wake registration described above as part of delivering coding results while clients are closed; slice 06 reuses it for routines. Schedule checks at 60-second intervals for active runs, with transient-error backoff up to 15 minutes. Persist the next check before releasing the tenant wake marker. Keep checking until a terminal provider state or an explicit owner stop, not an arbitrary total runtime timeout. After three consecutive failures, notify once that provider status is unavailable while continuing bounded retries; a permanent authentication failure becomes blocked with a reconnect-and-resume action. Clock restart restores checks. Cap concurrent coding runs at one initially; show queued work.

Keep summaries short and preserve provider work URL/PR URL. Follow-up messages to an existing coding task should enqueue a provider follow-up run only after its current run terminates; do not create another agent implicitly. Verify the provider's follow-up/cancel semantics before implementing them. If unavailable, show that state and the provider link, not a fake Stop success. Redact provider error bodies before returning them; the current 4xx passthrough needs attention.

[Cursor v1 API](https://prod.cursor.com/docs/cloud-agent/api/endpoints) was read on 2026-09-05. Its documented create identity and follow-up semantics support this approach; live account eligibility and successful execution remain pilot gates. Do not infer API credits from a desktop subscription.

### Phone and result UX

Reuse existing view-only VNC, Seat.Pointer/Seat.Type and touch transforms. A task's Open computer link opens display 1 for the existing pilot, with authenticated owner authorization, task context and expiry. Do not expose reusable bearer-seat tokens in WhatsApp or rely solely on stored senderHash.

Show Take control, agent-paused state, and Hand back. Losing the phone connection must not resume the agent unexpectedly while a human still owns the seat. Reconnect, re-authenticate, or explicitly release through the existing FSM. Login credentials are entered on the computer, never echoed into chat or stored as memory.

The web assistant view lists active tasks, items needing input and recent results. Task detail shows the actual WhatsApp messages and delivery state, artifacts, approvals and delegated run links. Large documents get authenticated previews/downloads. No public bucket URLs by default. Text remains selectable, the composer remains visible with the keyboard, and failed connections show recovery actions. Keep existing bot navigation as secondary access.

## Proposed slices

These are proposed boundaries, not published tracker tasks. Granularity confirmation is pending. On acceptance, publish one local file per slice under docs/plans/slices/ with its blockers; do not create external issues without a requested tracker.

| ID  | Outcome                                                                                       | Blocked by         | Finish and key cases                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01  | The verified owner can complete a lasting WhatsApp task and see the same exchange on web.     | None               | Stable acceptance, correct follow-up, one voice, long work, duplicate inbound, restart, uncertain delivery, unknown sender refusal. Existing group accounts remain unchanged.                                                                 |
| 02  | The owner can approve a precise action and use the computer from a phone to finish that task. | 01                 | Actual-phone login/takeover/hand-back, expiring links, wrong-user refusal, duplicate/changed approval refusal, reconnect. Reuse current desktop controls.                                                                                     |
| 03  | The assistant starts a cloud coding session and returns its evidence in WhatsApp.             | 01, 02             | Owner/repository binding, stable launch through timeout, persistent clock next-check registration, polling after restart/suspend, PR/work links, missing credentials and bounded retry backoff. Typed dispatch from 02 is reused.             |
| 04  | A correction changes the next turn; the owner can inspect and undo memory and instructions.   | 01, 02             | Real prompt resolution, revision checks, legacy note migration, snapshot-write bypass refusal, malformed fallback, restart and undo.                                                                                                          |
| 05  | The assistant saves a repeatable procedure as a skill and uses the edited version.            | 04                 | Runtime discovery and invocation, applicability/steps/output verification, edit/disable/revert, no tool or permission expansion.                                                                                                              |
| 06  | A routine created in WhatsApp runs on time after suspend and reports the result.              | 01, 02, 03, 04     | Dynamic schedule publication, timezone/DST, clock and tenant restart, test-run, pause, missed-run policy, dedup, no-op silence and failure auto-pause. Uses the clock registration proven in 03. Skills are optional, so 05 is not a blocker. |
| 07  | The complete personal workflow is usable without managing a bot roster.                       | 02, 03, 04, 05, 06 | Default assistant entry, task/result navigation, settings for learned behavior and routines, seven-day pilot with evidence. Per-slice UI is already usable before this final acceptance pass.                                                 |

Do not start with a generic task engine, provider framework or configuration dashboard. Extend the existing owner and message records while delivering slice 01; introduce each additional record only when its user-visible behavior lands.

## Files and existing patterns

Volatile interfaces first:

- Wire/types: api/DESIGN.md, api/spec.json, packages/shared/src/index.ts, api/computer.proto and packages/proto/computer.proto. Generate packages/proto/gen, never hand-edit it.
- Conversation/action lifecycle: apps/hub/src/service/conversations.ts, turns.ts, voice.ts, policy.ts; apps/hub/src/handler/agent.ts and connectors.ts; apps/eve/lib/tools/send_message.ts and channels/whatsapp.ts.
- Coding: apps/hub/src/service/coding.ts, handler/seat.ts; existing code-route conversation records. Add the polling owner alongside current supervision, not in the web request.
- Behavior: apps/hub/src/service/state.ts, files.ts, bots.ts; new small validated configuration service if state.ts cannot own the revision lifecycle cleanly; apps/eve shared dynamic resolvers and main/template project re-exports.
- Routines/wake: apps/hub/src/host/routines.ts, wake.ts, init.ts; apps/clock/src/index.ts, schedule.ts, tenant.ts; packages/shared cron helper.
- WhatsApp transport/identity: apps/whatsapp-bridge/src/account.ts, accounts.ts, routing.ts, owner.ts, hub-client.ts and send-envelope.ts. Account-scoped secrets stay distinct from admin secrets.
- Web: components/chat-pane.tsx, whatsapp-channel.tsx, desktop-pane.tsx, invite-desk.tsx; lib/seat.ts, invite.ts, use-desk-touch.ts and desk-view.ts.
- Docs/deploy: docs/BOTS.md, GROK-BOT.md, WHATSAPP-PARITY.md, DEPLOY.md and plans/gateway.md. Resolve stale claims as touched behavior ships. Avoid a wholesale historical rewrite.

Use installed Eve, Node filesystem/HTTP primitives, existing JSONL state and current auth. No new queue, database, vector service or WhatsApp library is proposed. If a dependency is required, document why these existing rungs cannot support that slice.

## Verification

Commands are for implementation, not claims of checks run during planning. Run focused cases while developing and npm run check at each finished slice. Current root check runs all workspace tests, beyond the older AGENTS description.

- From apps/hub: npx vitest run test/conversations.test.ts test/whatsapp.test.ts test/policy.test.ts test/turns.test.ts --maxWorkers=2. Add named cases for duplicate inbound, restart recovery, more-than-150-second capability renewal, revoked parked task, wrong-owner approval, changed-payload approval and delivery uncertainty. Expected: one task/action identity and no unauthorized dispatch.
- From apps/eve: npx vitest run lib/channels/whatsapp.test.ts test/whatsapp-runtime.test.ts --maxWorkers=2. Add test/whatsapp-runtime.test.ts: build/start a fixture with the installed Eve runtime, a test hub and a deterministic model endpoint, then send two turns and restart the hub while work is parked. Assert current-turn selection, capability renewal and one delivery. A mock of drainStream alone is insufficient.
- From apps/whatsapp-bridge: npx tsx --test src/routing.test.ts src/hub-client.test.ts src/send-envelope.test.ts. Expected: PA identity fails closed; legacy configured groups retain behavior; retries preserve identity and uncertain sends do not automatically repeat.
- From apps/web: npx vitest run lib/invite.test.ts lib/invite-mint.test.ts lib/desk-view.test.ts --maxWorkers=2. Add owner/task link and expiry cases. Expected: wrong user cannot redeem; coordinate transforms remain correct.
- From apps/hub: npx vitest run test/coding.test.ts --maxWorkers=2. Add timeout-after-create, 409 reconciliation, restart polling, out-of-scope repository and sanitized error cases. Expected: exactly one provider agent identity, truthful state and original-task delivery.
- From apps/hub: npx vitest run test/state.test.ts test/bot-profile.test.ts --maxWorkers=2. From apps/eve: npx vitest run test/runtime-config.test.ts --maxWorkers=2. Add the latter fixture using the installed Eve runtime and a deterministic model endpoint that captures its assembled request. Expected: a later turn sees the chosen revision, wrong-owner/direct-file edits cannot activate it, undo and restart preserve state. Test an authorized action occurrence completing without a widget or blocked conversation.
- From apps/clock: npx tsx --test src/schedule.test.ts src/tenant.test.ts src/registration.test.ts. Add registration.test.ts for dynamic registration/revision persistence and authenticated tenant targeting. From apps/hub: npx vitest run test/routines.test.ts test/runtime-routines.test.ts --maxWorkers=2. Add runtime-routines.test.ts for DST, missed-run and cancellation cases. Expected: one accepted occurrence and no accidental tenant-wide wake loop.
- npm run proto:check, npm run proto:gen when the wire changes, then npm run check. Expected: synchronized contract/generated output and all required checks green. Run suites serially.
- Real path, authenticated test accounts only: WhatsApp text and voice note, task beyond old HTTP timeout, bridge/tenant restart, phone takeover on iPhone and Android, suspend before routine, clock restart, small test-repo coding run, and completion after closing every client. Record message/task/provider IDs with secrets removed.
- Before a guest deploy: docker build -f deploy/fly/Dockerfile -t expert-guest-verify . as required by repo guidance. Preserve .dockerignore exclusions for local Eve output. Deploy only when implementation work separately authorizes it.

Suggested pilot acceptance targets, not existing metrics: a visible acknowledgement within 10 seconds for at least 19 of 20 healthy-network inbound requests; every accepted test task ends in a result or explicit blocked/failed state; no duplicated deliberate side effect across controlled retries; no unauthorized actions in identity/approval cases. Record resume latency separately. Seven days of routine observations must account for every expected occurrence as completed, failed, cancelled or missed.

Do not claim exactly-once behavior over external GUI actions or delivery guarantees the provider cannot expose. Unknown outcomes remain visible and require reconciliation.

## Rollout, migration and recovery

Enable the new PA path for Matt's account only, with legacy group routes staying on their current behavior. Back up hub-owned state before migration; use versioned schemas and idempotent imports. Keep old data until new readback is verified.

Introduce the new sender and config revisions alongside old readers. Route each task through exactly one delivery owner. If rolling back, stop new acceptance on that path, reconcile pending/uncertain sends, and leave accepted task records available. Never turn on the old final-text sender for already-accepted new-path tasks.

Ship the clock's persistent registration support with slice 03, then reuse it when enabling runtime-created routines. Keep them pending if registration fails. On rollback, disable new dynamic activations and preserve registrations/run history until jobs are explicitly retired. Do not delete a pending queue to clear an error.

Roll back a bad behavior edit by activating a previous revision. Do not rewrite transcripts or imply past actions were undone. Do not delete existing bot directories or roster rows as a UI simplification.

## Cuts and explicit limits

Defer personality teams, bot-to-bot orchestration, marketplace publishing, public billing/provisioning, extra messaging providers, simultaneous Whatsmeow backfill, native app rewrites, self-modifying TypeScript/runtime binaries, automatic production deployment and extra coding harnesses.

Keep voice notes, artifacts, exact ownership, delivery recovery, phone takeover and genuine runtime behavior changes. These serve the current requirement and cannot be traded away for a prettier onboarding page.

The scope cut was presented in the conversation input panel and is unanswered at this revision. It is the recommendation used to make this proposal concrete, not recorded user approval.

## STOP conditions and remaining gates

Stop the affected implementation slice and report evidence if:

- The deployed bridge/tenant topology differs from the assumed hub connector path, verified via docs/DEPLOY.md and the deployment's non-secret health/config evidence.
- Installed Eve cannot select the current turn or resolve runtime instructions/skills as its types suggest. Prove with an integration fixture before replacing continuation behavior.
- Workflow persistence cannot be established on the volume. Fail readiness for background work instead of accepting jobs onto ephemeral storage.
- An owner binding or requested repository scope cannot be verified. Ask for that identity/scope; do not infer it from a number suffix, group membership or model text.
- Cursor account access or stable agentId semantics fail in the live test. Keep coding unavailable; do not fall back to a model-readable key or local harness.
- Dynamic wake registration cannot survive clock restart. Do not label a routine enabled.
- Launch scope changes to shared public contacts or public signup. That adds provider eligibility, provisioning, abuse controls and billing work outside this pilot.

Ordinary conservative implementation deviations are recorded in whatsapp-personal-assistant.notes.md under Deviations and How the run ended. Finish each slice with its demonstrated outcome, an isolated external blocker, or a named scope boundary.

## Review notes

Reviewed 2026-09-05 using the planning rubric and verified local claims. The starting draft was discovery-only, not an executable plan.

| Dimension    | Before | After | Remaining limit                                                                                                                       |
| ------------ | ------ | ----- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Completeness | 2/5    | 4/5   | Precise contract proposals and per-slice tickets need final review after scope selection.                                             |
| Feasibility  | 3/5    | 4/5   | Installed APIs support the approach; live continuation, provider access and dynamic wake persistence still require first-slice proof. |
| Scope        | 2/5    | 4/5   | Proposed cuts and slice granularity await selection; no external work dispatched.                                                     |
| Testability  | 1/5    | 5/5   | Exact new runtime fixtures, boundary cases, commands and real-path finish lines included.                                             |
| Risk         | 2/5    | 4/5   | Rollout and ambiguous-action recovery defined; actual provider and deployed auth tests remain gates.                                  |
| Assumptions  | 2/5    | 5/5   | Pilot, transport, provider, phone and runtime assumptions explicitly labeled with invalidation checks.                                |

Adversarial review resolutions: added expiring task-capability renewal, separated action occurrences from consent widgets, removed the false private-loader assumption, made coding monitoring survive arbitrarily long valid runs through the clock, and named new real-runtime test fixtures.

<!-- UNRESOLVED: Finalize scope/granularity and exact wire proposals before publishing executable slice tickets. Verify real Eve continuation, account eligibility and durable wake registration during their bounded tracer slices; do not assert all dimensions are 5/5 from code inspection. -->

## Plan validation

- Answers the request: Outcome and scope; Product decisions; First complete demonstration.
- Answers landed: all explicit user requirements are included. Two earlier choice questions and the final scope-cut question have no submitted answer; no defaults are described as consent.
- Scope gate: Cuts and explicit limits; Proposed slices; reuse decisions in Files and existing patterns.
- Assumptions explicit: working launch assumption; STOP conditions and remaining gates.
- Verification: named workspace commands, required root check, real-phone/restart/suspend/provider scenarios and suggested pilot targets above.
