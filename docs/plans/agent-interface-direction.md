# An assistant you can message, with work you can see

Product direction, 2026-09-05. Companion to [the WhatsApp assistant plan](whatsapp-personal-assistant.md). This is a first-principles recommendation grounded in the current Done Bear checkout, its public playground, and current platform documentation. It does not authorize a product merger or implementation.

## Brief and conclusion

User: someone delegating personal and software work, often from a phone. Job: request an outcome, leave, resolve the occasional decision, and receive a usable result. Assume short responses, remote coding, persistent computer use, and plugins/MCPs/APIs.

Desired outcome: starting work is as easy as messaging; returning to several concurrent jobs does not require rereading transcripts. Success means less human attention per successfully completed outcome, including time spent recovering from mistakes. Consequence: delegated actions may alter external systems, so their actual state, scope and result must remain inspectable.

Recommendation, revised after Matt's clarification and Captain inspection: a few persistent workspaces, one main conversation for steering work, and independent job conversations with attached previews, computers and coding sessions. The main conversation is the default place to work; a compact attention overview complements it. Done Bear supplies commitments and task organization where useful. WhatsApp reaches the same main assistant. A task board is not the required front door, and coding/design remain iterative conversations.

This is a product hypothesis, not a claim that Done Bear has won comparative usability tests. The proposed category is a personal assistant that carries work through to completion; a general replacement for Slack, Linear or cmux is outside scope.

## First principles

1. Input is often ambiguous, so natural language is useful. Do not require people to select an agent, model, tool, project and workflow before asking. A quick question stays a quick question; a lasting commitment creates a task automatically. Distinguish "remind me to cancel" from "cancel". Rule: `rule/smallest-intervention`.
2. Work continues outside a conversation. Several simultaneous jobs need stable identity, current state and a result. A transcript explains what happened but makes a poor index of what needs attention. Proposed coverage gap, `rule/work-outlives-conversation`, State coverage: every accepted background job remains addressable across channels and client closure.
3. Human attention is scarce. Surface decisions and failures above uneventful activity. Short text can still be overwhelming if every tool call becomes a notification. Rule: `rule/one-primary-action`; proposed coverage gap, `rule/attention-over-activity`, Hierarchy and structure: prioritize items requiring human action over background progress.
4. Work has an object. Code is best reviewed as a diff or preview; a document as a document; login in the computer; a question in chat. A transcript should link to these rather than flatten everything into prose. Rules: `rule/inline-before-modal`, `rule/navigation-vs-action`.
5. Delegating does not remove ownership. Show what will be affected and whether the system is waiting for the person, the provider or a scheduled time. Tool names are implementation details unless they explain a meaningful choice. Rules: `rule/name-object-scope-consequence`, `rule/cover-reachable-states`.
6. Familiar entry points reduce effort, but the same job must survive moving between them. A WhatsApp notification should open the exact work, not a new generic chat. Rule: `rule/preserve-mental-model`.

## Comparing the surfaces

These fit judgments assume the user's personal-assistant scenario, not a universal ranking.

| Surface   | Natural object                        | Where it is strongest                                                         | Limitation for this scenario                                                                             | Role to borrow                                                                                              |
| --------- | ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| WhatsApp  | Contact and message                   | Immediate requests, voice, forwarding context, answers on a phone             | A single conversation becomes hard to scan across many jobs; rich review needs another surface           | Capture and return channel                                                                                  |
| Slack     | Shared conversation and workspace     | Work originating in team discussions, human coordination, shared context      | Requires decisions about channels, audiences and workspace; personal work is awkward in employer context | Team entry point when demanded                                                                              |
| cmux      | Workspace, terminal and live session  | An operator supervising parallel coding processes and inspecting output       | Exposes execution machinery when the user only wants a finished outcome                                  | Optional technical inspection; attention notifications and per-job workspaces                               |
| Linear    | Issue and project                     | Accountable team work, dependencies, coding and review                        | Issue fields and team workflows add overhead to ordinary personal requests                               | Durable work identity, delegation, linked sessions and results                                              |
| Done Bear | Personal commitment, project and task | Calm overview across personal and work commitments, scheduling, quick capture | Current model and UI do not yet unify task outcomes with delegated execution and attention               | Commitment tracking and supporting overview; its task list is not the proposed default conversation surface |

Current platform facts: [Slack supports agent sessions and contextual messaging](https://docs.slack.dev/ai/developing-agents/), so it should not be dismissed as a basic chatbot container. [Linear supports cloud coding sessions with reviewable changes](https://linear.app/changelog/2026-06-11-coding-sessions), including requests originating in chat and Slack. [cmux provides terminal workspaces, notifications and a control API](https://cmux.com/docs/getting-started). Its documented session restoration is not arbitrary process checkpointing. The distinctions above concern which object should organize the experience, not theoretical platform capability.

## What Done Bear actually has

I inspected `../donebear`, including its manage-frontend guidance, task model and status derivation, task detail, agent page/shell/provider, message approvals, session hooks and synced AgentThread model. I also inspected the live `/playground/today` browser surface. Authenticated agent behavior was not tested: the normal site redirected to sign-in, and the playground deliberately disables the agent.

- The playground has Inbox, Today, Upcoming, Anytime, Someday, teams, projects and Logbook. The central interaction is a task and its completion checkbox.
- `packages/task-logic/src/task-status.ts` derives `open`, `done` and `archived`. `started` is a scheduling field used to derive Today/Anytime, not proof an agent is executing.
- `apps/manage-frontend/src/components/pages/agent/agent-page.tsx` renders an independent chat destination with history and a new-chat action. The floating shell preserves the conversation when its presentation changes.
- `apps/manage-frontend/src/components/agent/agent-message.tsx` already supports approval/input requests and summarized tool activity. These are useful existing patterns, not a missing capability to rebuild.
- `apps/manage-frontend/src/lib/sync/models/agent-thread.ts` holds a user-private session cursor and title; the Task model is workspace-scoped. The inspected models contain no first-class association between a task, delegated run, outcome artifact and required decision. Search did not reveal a corresponding execution UI in the inspected application paths.
- Task detail already supplies descriptions, attachments, comments, dates, assignment and repeat controls. The existing agent context includes current task-list view, local date and timezone.

These findings support extending existing work objects rather than starting another generic chat product. Rule: `rule/smallest-intervention`.

## Proposed experience

Keep the main assistant conversation as the landing surface. Add a focused delegated-work overview beside it, reachable on phone without losing the conversation. Keep Done Bear's Today for existing task-manager users. Product integration remains a proposal, not an instruction to merge applications. Rule: `rule/preserve-mental-model`.

One main composer accepts requests and ongoing discussion. A supporting overview uses simple rows grouped by **Needs you**, **In progress**, and **Recent results**. Empty sections disappear; no work is a successful quiet state. Scheduled work and all history remain reachable. Keep personal to-dos distinct so delegating does not merely add more chores to Today. Rules: `rule/structure-before-containers`, `rule/empty-state-action`, `rule/one-primary-action`.

Example content, illustrative only:

| Work                    | Current fact                   | Next interaction        |
| ----------------------- | ------------------------------ | ----------------------- |
| Fix checkout failure    | Change ready; checks passed    | Review change           |
| Update delivery address | Waiting for your account login | Open computer           |
| Find weekend activities | Comparing options              | Open task if interested |
| Prepare Monday brief    | Next run Monday at 7 am        | View routine            |

Each job opens its ongoing conversation and attached work, with current outcome or blocker easy to find. Coding and design can iterate across many runs in that same conversation. Computer or review can appear beside it on desktop and as a full-screen destination on phone, with an explicit return to the same job. Avoid forcing a tiny remote desktop into every task card. Rules: `rule/inline-before-modal`, `rule/preserve-mental-model`, `rule/navigation-vs-action`.

## Captain: one main conversation, many independent jobs

Matt clarified that he usually handles many tasks, wants a few workspaces and expects to keep chatting with the main one. This supersedes the earlier task-board-first recommendation. I read Captain's README, architecture guidance, live-row derivation, verdict validation, repository memory and Done Bear adapter. No fleet was launched or modified.

Verified local inspiration:

- `../captain/README.md` defines one driving session with a fleet of per-issue worktrees and agents.
- `../captain/src/captain/view.ts` derives Needs you, In flight and Ready from pending gates, run state and verdict. Each row has a stable identity, a next action and a fingerprint of actionable state. That is an attention interface rather than an agent directory.
- `../captain/src/captain/verdict.ts` validates result shape and compares its rubric hash when a current rubric hash is available. Transfer the principle of evidence tied to acceptance criteria; do not imply every idle process has completed its work or that this is an unconditional security guarantee.
- `../captain/src/donebear.ts` maps a task and its unchecked checklist items into a source-neutral brief and acceptance criteria. Done Bear can therefore be a source of commitments without becoming the mandatory place every conversation starts.
- `../captain/src/memory.ts` separates curated repository rules from a bounded inbox of learnings. Scoped learning can improve later jobs without appending every worker transcript to the main conversation.

Proposed hierarchy: account access boundaries contain a few user-visible workspaces; each workspace contains independent jobs. The main assistant is the default conversational entry across the user's authorized workspaces. Workspace names are persistent contexts such as Personal or Products, not one new workspace per launch. Captain's cmux workspaces generally correspond to these job execution environments instead. Rules: `rule/smallest-intervention`, `rule/preserve-mental-model`.

The main assistant keeps a compact live index of jobs and retrieves scoped context when needed. It should remain available while workers execute. A main message can start several jobs, reprioritize one, answer a pending question or discuss a result. Each dispatch has a stable identity and selected brief; the worker owns its detailed conversation and artifacts. The main conversation is not the only record of pending work. Proposed coverage gap: `rule/work-outlives-conversation` above.

Routing must be visible: replies to a job card target that job; a selected workspace scopes new work; a named job can be addressed from the main conversation. "Make it simpler" targets the clearly active preview/job, and requires a short clarification if several jobs could plausibly match. Never broadcast an ambiguous instruction to every worker. Rules: `rule/preserve-mental-model`, `rule/name-object-scope-consequence`.

Opening a worker conversation for detailed design or code review is optional. Its decisions and result update the shared job record so the main assistant can pick up the work without asking the person to recap. Unrelated personal or company context is not copied to a worker. Workspace selection is not itself authorization; existing account and external-connector permissions still apply. Rules: `rule/no-redundant-entry`, `rule/name-object-scope-consequence`.

Borrow Captain's coordination pattern, not its entire runtime. Its stateless CLI reconstructs from local cmux/worktree evidence; remote phone and WhatsApp work still need the durable execution and wake protocol in the implementation plan. A running job should not occupy the main assistant's conversation turn. Resource queues and dependencies remain truthful when jobs cannot actually run concurrently. Do not import Captain's local bypass flags or require plan approval for every already-authorized action. Rules: `rule/cover-reachable-states`, `rule/smallest-intervention`.

Slack becomes an optional team channel, not the organizing requirement. The proposed personal interface is a main conversation, a small workspace switcher, a compact list of jobs requiring attention, and an attached work surface. Keep bots discoverable when their capabilities or permissions matter, but do not make people manage their DMs to complete one outcome. Rule: `rule/smallest-intervention`.

The assistant has one default identity. Skills and execution providers can change under a task; expose their identity when it explains access, cost, capability or a handoff. Separate assistants remain useful for different owners or permissions. No personality selection is required to request work. Rule: `rule/smallest-intervention`.

Memory, instructions, skills and routines are inspectable under assistant settings, with conversational edits and version history. Common corrections should not require opening that settings area. Rule: `rule/smallest-intervention`.

## State and action semantics

Keep three concepts separate: the user's commitment, an execution attempt, and the attention it needs. An agent finishing a run does not automatically mean the user's task is done. "Prepared a refund request" is not "Refund received"; "Opened a PR" is not "Fix deployed". A task may contain several attempts and several results. Rule: `rule/success-state-specific`.

| Reachable state              | What the person sees and can do                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Draft or locally queued      | Request preserved; clearly not yet accepted for execution                                                          |
| Accepted or queued           | Stable task with truthful queue/dependency state                                                                   |
| Running                      | Last meaningful verified update; no fabricated percentage; open work or request stop                               |
| Waiting for a person         | Exact question, approval, login or review action                                                                   |
| Waiting for a system         | Dependency, scheduled retry or next scheduled run; no false user blocker                                           |
| Result available             | Concise outcome, evidence and any unmet part of the request                                                        |
| Failed or partially complete | Completed work preserved, precise failure and safe recovery action                                                 |
| Status unavailable           | Last known state and timestamp; no assumption execution stopped                                                    |
| Stopping or stopped          | Actual provider acknowledgement; completed side effects remain visible                                             |
| Offline, expired or denied   | Cached state marked; preserve draft/task through reconnection or authentication; never imply an offline action ran |

Rules for the entire matrix: `rule/cover-reachable-states`, `rule/error-states-recovery`, `rule/preserve-user-input`, `rule/time-limit-adjustable`.

Already-authorized work proceeds without redundant confirmation. New consequential scope gets a specific preview and decision. Stop means request cancellation of current execution, not undo previously sent messages or deployed changes. Archive hides a task without cancelling it, and is reversible. Configuration undo restores a prior configuration revision, not external effects. Review links navigate; approve, stop and resume controls perform actions. Rules: `rule/name-object-scope-consequence`, `rule/irreversible-action-safeguard`, `rule/undo-only-when-honest`, `rule/navigation-vs-action`.

Notification defaults: decisions, meaningful blockers, requested reminders and useful results. Routine no-ops and tool steps stay quiet. Choosing read in one surface should not produce an extra decision on another; answering consumes the same pending action. Proposed coverage gaps: `rule/attention-over-activity` and `rule/work-outlives-conversation` above.

Do not copy user-private agent transcripts into workspace-shared tasks automatically. Share the selected brief/result explicitly, and enforce access independently on task, transcript, artifact, computer and coding links. This boundary already exists in Done Bear's sync models and must survive integration. Rule: `rule/name-object-scope-consequence`.

## Relationship to Expert and next experiment

Use Done Bear as the candidate place to manage commitments and Expert as the candidate execution owner for computer and coding. Start with one linked workflow, not a repository or branding merger. If integrated, Done Bear owns task scheduling/completion, Expert owns authoritative execution status and approval consumption, and messaging adapters deliver projections of the same run. Avoid two independently writable execution statuses. The precise authenticated integration contract remains future implementation work. Rules: `rule/smallest-intervention`, `rule/preserve-mental-model`.

Build one vertical experiment: start a small code change from WhatsApp, see it as delegated work in Done Bear, close both clients, then review its result from the same task. Also exercise one phone-login blocker and one request with no project or due date. Reuse existing artifacts and computer UI. Leave cmux and Slack integration out of this experiment unless the user's workflow requires them.

Compare current chat, current task UI and the proposed work view using the same five simultaneous jobs. Ask a person returning later to find all unresolved decisions, identify what actually finished, revise one request, recover a failure and inspect one output. Measure task accuracy, time, transcript reading, unnecessary interruptions and mistaken actions. This is a proposed test, not measured evidence. A task list that forces users to do more organizing fails even if it looks tidy. Rule: `rule/cover-reachable-states`.

Follow-on ownership: `ui-design` for prototype and rendered mobile/desktop accessibility checks; `copywriting` for production state/action wording; `ui-animation` only for transitions after state semantics are agreed. No implementation or changes to Done Bear were made in this pass.

Shape-pass self-check: brief complete; decisions mapped to registered rules or explicitly proposed coverage gaps; consequential actions distinguish reversibility; reachable states specified; build and verification routed. Comparative usability and authenticated runtime behavior remain unverified, so the recommendation is not a usability-test verdict.
