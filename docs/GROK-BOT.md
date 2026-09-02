# Grok Bot, and what a web clone of it needs

Research date: 2026-09-02. Sources are xAI's docs and launch post, Cursor's help pages, press coverage, and the community reconstructions already cited in [`api/RESEARCH.md`](../api/RESEARCH.md). Where something is not public it is marked unknown rather than guessed. The second half maps the product onto this repository and lays out the order of work for a web client.

## 1. The product

**Pitch.** "Grok Bot is your team of always-on agents. They have their own computer, work inside tools and apps like you do, and keep working 24/7." Bots are framed as teammates, not tasks: you message them like a coworker, they sign into your tools, finish multi-step jobs, and come back only when something needs approval. ([x.ai/news/introducing-grok-bot](https://x.ai/news/introducing-grok-bot))

**Launch and ownership.** Early beta on 11 August 2026. xAI merged into SpaceX in February; SpaceX closed its acquisition of Cursor on 15 August. Grok Bot is effectively a Cursor-built product: sign-in is a Cursor account, billing and privacy follow Cursor's, the desktop app is downloaded from downloads.cursor.com and speaks Cursor's internal Connect-RPC protocol. ([docs.x.ai/grok-bot/get-started](https://docs.x.ai/grok-bot/get-started), [cursor.com/help/grok-bot/getting-started](https://cursor.com/help/grok-bot/getting-started), [TechCrunch](https://techcrunch.com/2026/08/15/spacex-officially-closes-its-cursor-acquisition/))

**Pricing.** No standalone SKU. Bundled into SuperGrok Plus/Heavy (~$300/mo for Heavy), Cursor Pro+/Ultra ($200/mo), Cursor Teams Standard/Premium ($120/seat/mo). A weekly usage allowance separate from model limits; overage billed on-demand from token cost. ([docs FAQ](https://docs.x.ai/grok-bot/faq), [teams docs](https://docs.x.ai/grok-bot/teams-and-enterprises))

**Platforms.** Electron desktop for macOS and Windows; iPhone app (iOS 18+). No Linux, Android, iPad, web client, or CLI. ([FAQ](https://docs.x.ai/grok-bot/faq), [App Store](https://apps.apple.com/us/app/grok-bot/id6794501026)) A web client is therefore a real gap in the market, not a copy of something that exists.

**Model.** Undisclosed: "a fixed set of models with automatic failover", no picker. Grok 4.6 shipped the day after and is the obvious candidate, unconfirmed. ([x.ai/news/grok-4-6](https://x.ai/news/grok-4-6))

### Core features

- **One cloud computer per user account, not per bot.** A persistent managed Linux VM with Chrome, a filesystem (`/workspace` durable; other paths may be wiped), and a terminal. All of a user's bots share it, including browser sessions, cookies and CLI credentials. Each bot gets its own screen so bots run in parallel; each bot runs one computer-use task at a time. The docs say twice: "Do not use separate Bots as a security boundary." On Teams every member gets their own VM. ([computer-and-apps](https://docs.x.ai/grok-bot/computer-and-apps), [FAQ](https://docs.x.ai/grok-bot/faq))
- **Always-on.** Closing the app, laptop or phone does not stop a background turn or routine.
- **Work-surface ladder.** Memory and files → connector (MCP) → public web → signed-in browser → desktop GUI → hand to the human. Connectors are preferred over clicking when one exists. About 220 connectors at launch (Google Workspace, Slack, M365, Salesforce, Notion, GitHub, Jira); remote HTTP MCP supported, local stdio MCP not. ([computer-and-apps](https://docs.x.ai/grok-bot/computer-and-apps), [Vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown))
- **Skills, routines, teach-a-task.** Skills are structured procedures invoked with `/` in the composer and enabled per bot. Routines are a skill on a schedule (with timezone) or an event trigger (Slack message, GitHub notification); up to 50 per bot, last 20 runs kept, "Test run", auto-pause after inactivity. Teach a task records the user performing a task once on the cloud computer (≤10 min) and drafts a skill. ([skills-routines-and-automations](https://docs.x.ai/grok-bot/skills-routines-and-automations))
- **Multi-agent.** Bots have separate histories, can DM each other, share files through the machine, and join group chats of 2–6 with visible handoffs. Max 50 bots per account. ([bots docs](https://docs.x.ai/grok-bot/bots))
- **Memory.** Per-bot durable preferences and facts; documented as a convenience, not authoritative; no inspection UI. Changing facts belong in `/workspace` files.
- **Cursor Cloud Agents** can be spawned for coding so repo work does not contend with the bot VM.
- **No X integration** is documented, despite the name.

### UX

- **A messaging app, not a task runner.** Left sidebar of named bots (avatar colour/shape, title, pin/hide/sections), a chat pane, a right-hand details panel. Conversations centre on bots. ([VentureBeat](https://venturebeat.com/orchestration/spacexais-grok-bot-turns-agents-into-persistent-digital-coworkers-that-can-operate-your-apps-for-120-per-month), [MindStudio](https://www.mindstudio.ai/blog/grok-bot-setup-guide))
- **Onboarding.** Sign in → short questionnaire about tools → concept intro (bots, shared computer, routines) → the computer provisions in the background → "Meet a future teammate" with suggested bots or "Create new agent". A new bot's first turn is a conversational intake. ([get-started](https://docs.x.ai/grok-bot/get-started))
- **Starting work.** A message, a scheduled routine, or an event trigger. Composer takes `/skill`, up to six attachments, voice dictation on iOS.
- **Watching.** Two views: the conversation (tool cards, files, questions, approval cards; model reasoning stays off-screen, the transcript shows only _occurrences_) and the **Agent Computer**, a live view opened from a computer icon showing clicks, typing, navigation and status. Results arrive as file cards. ([computer-and-apps](https://docs.x.ai/grok-bot/computer-and-apps), [files-and-results](https://docs.x.ai/grok-bot/files-and-results))
- **Intervening.** Approval cards (Allow once / Deny / Always allow); **takeover** of the shared desktop for passwords, passkeys, 2FA, CAPTCHAs, payments, then hand back; question widgets with 1–6 options that end the turn; masked secret requests excluded from transcript and model context. ([approvals docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy))
- **Mobile.** Mirrors bots/chats/routines, shows the live computer, supports takeover; a "task dispatcher" with no routine editing or teach-a-task.
- **Reported friction.** Metering bugs at launch, long routines hard to debug, bots stopping just before completion to verify, no dry-run mode, a HN thread centred on always-on agents holding all credentials and on token burn. ([eesel](https://www.eesel.ai/blog/grok-bot-review), [HN](https://news.ycombinator.com/item?id=49261514))

### Architecture (public or reconstructed)

- Electron client; a v0.18 reconstruction shows renderer / preload / main / coordinator / host / box process boundaries and a turn loop where the model's text is private and the only user-visible voice is a `SendMessage` tool call. Wake contexts (`user`, `[first run]`, `[inbound]`, `[routine]`, revival) enter one runner. Tools include `Read`, `Shell`, `CopyToBox`/`CopyFromBox`, `CreateAgent`, `request_box_help`. Unofficial. ([learn-grok-bot](https://github.com/yuanyijie/learn-grok-bot))
- UI ↔ host is Cursor's Connect-RPC/protobuf streaming (`aiserver.v1.InferenceService/Stream`), discovered by [grokbot-shim](https://github.com/codeaashu/grokbot-shim).
- Computer control is not documented. The shim's local stand-in is a Docker container with XFCE + Chrome exposing screenshots and input injection plus noVNC on `:6080` for takeover. Whether production is Firecracker or containers, and VNC or WebRTC for the stream, is **unknown**; the 0.18 reconstruction says x11vnc → websockify → noVNC.
- No public API or SDK for Grok Bot itself. Relevant xAI platform pieces are the Responses API with server-side tools (web search, X search, code execution, remote MCP).

### Safety

Approval gates before sending, publishing, purchasing, deleting, permission changes, production changes; "Require approval" beats "Always allow". Model-based **Auto Review** of tool calls, with user-authored prose rules. Credentials never in chat; takeover for auth; masked secret requests; connector tokens outside model context; WebAuthn forwarded to the member's device on Teams. Deleting a bot is a soft delete and does not clear shared sessions. Audit today is the transcript plus usage dashboards; "an audit view of Bot actions is coming." No published retention policy or prompt-injection guidance. ([approvals docs](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [teams docs](https://docs.x.ai/grok-bot/teams-and-enterprises))

### Competitors and what is converging

| Product                                 | Compute                                         | Live view / takeover         | Approvals                          | Scheduling                     |
| --------------------------------------- | ----------------------------------------------- | ---------------------------- | ---------------------------------- | ------------------------------ |
| Grok Bot                                | 1 persistent VM per user, shared by bots        | yes / yes (desktop + iPhone) | once / always / deny + Auto Review | routines + event triggers      |
| ChatGPT Workspace Agents (Apr–Jul 2026) | cloud agents; Operator and "agent mode" retired | virtual browser              | review boundaries                  | scheduled + API/Slack triggers |
| Claude Cowork (web/mobile Jul 2026)     | fresh cloud session per task                    | computer-use preview         | for significant actions            | scheduled tasks                |
| Manus Cloud Computer                    | persistent Ubuntu                               | yes                          | ,                                  | scheduled + webhooks           |
| Genspark, Devin, Browser Use Cloud      | cloud computer / sandbox                        | varies                       | ,                                  | some                           |
| OpenClaw / Hermes (OSS)                 | self-hosted                                     | varies                       | varies                             | cron                           |

Converging: a persistent cloud computer that outlives the device; a live screen with human takeover for auth; tiered approvals plus an automated reviewer; scheduled and event-triggered routines; teach-by-demonstration; multi-agent orchestration; connectors first, GUI automation as fallback. Grok Bot's distinctive choices are the bot-as-teammate messaging UI, one shared VM with per-bot screens, and bundling into Cursor.

## 2. Where this repository stands

The substrate already matches the shape that matters: one shared Linux box, one 1280×800 screen per bot, a closed `computer` action union in pixel coordinates, XTEST input, view-only VNC with all human input through a seat FSM, `request_takeover`, question widgets and masked secret requests as turn-ending occurrences, per-bot profile/memory/transcript on `/workspace`, Grok's persistence boundary, a hub-side policy gate, runtime provisioning of bots, and Eve as the harness with a daily routine. That is more of the desktop contract than most public clones have.

| Grok Bot                                                      | Here                                                                                    | Gap                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| One computer per **account**                                  | One computer per **tenant** (seeded `matt` / `vcmc` Fly apps); session binds to one hub | Self-serve Fly Machine per sign-up; seats on a guest are still full owners                         |
| Bot-centric messaging UI: sidebar of bots, profiles, sections | One chat pane keyed by whichever screen is selected; bot identity is a `<select>`       | Whole information architecture                                                                     |
| Live Agent Computer view                                      | Yes (noVNC iframe, take-the-seat, I'm done, multi-screen banner)                        | Polish: pause vs take, who holds the seat, hand-back confirmation                                  |
| Approval cards once / always / deny                           | Eve's `input.requested` cards render; hub policy has allow/ask/deny                     | No "always allow" memory; no action preview; approvals live in two places                          |
| Question widgets, masked secrets                              | Hub has both (`SendMessage`, `ProvideSecret`)                                           | **Clients never read the occurrence log**; no `AnswerWidget` RPC; web shows Eve's raw text instead |
| Routines with schedule + triggers, run history, test run      | One cron in `agent/schedules/`; no UI, no history                                       | Everything user-facing                                                                             |
| Skills, `/skill` in the composer, teach-a-task                | Skills exist in the Eve project; nothing in the UI                                      | Composer integration, per-bot enablement                                                           |
| Connectors / remote MCP                                       | `COMPUTER_MCP_URL` for one MCP server                                                   | Catalogue, OAuth, per-account sharing                                                              |
| Multi-agent DMs and group chats                               | Bots share `/workspace`; nothing else                                                   | All of it                                                                                          |
| Memory                                                        | `memory/profile.md` read into the prompt                                                | Inspection/edit UI                                                                                 |
| Files and results as cards, attachments in the composer       | Bare links; no upload                                                                   | Cards, upload, preview                                                                             |
| Mobile                                                        | The Expert iOS app (chat, task cards, desk view, skills sheet); web layout stacks       | Web mobile layout, notifications when `WAITING`                                                    |
| Audit                                                         | Transcript on disk                                                                      | Action log view                                                                                    |
| Sleep / wake-on-connect                                       | Machine stays running                                                                   | Fly suspend on idle + wake on request (an edge proxy that can carry WebSockets)                    |

### Reference: the Expert iOS client

The iOS app is the closest thing to a target for the web client, so the surfaces it already has are the ones the roadmap below should reproduce rather than reinvent. Screenshots are in [reference/](reference/).

**Chat with task cards** ([ios-chat-task-card.png](reference/ios-chat-task-card.png)). One conversation with the bot, day separators, a "New" divider at the first unread bubble, and a card for each task the bot ran: title, status pill (Done), the branch and PR number, the file and line delta, and View PR / Open in Cursor actions. The bot's own progress arrives as short bubbles ("Merged PR 13. Fly is building the image..."), which is the `send_message` voice in [DESIGN.md](../api/DESIGN.md), not the model's scratchpad. A screen icon in the header opens the desk. The composer is one field ("Ask Expert") with an attach button and dictation.

**Skill and connector sheet** ([ios-skill-sheet.png](reference/ios-skill-sheet.png), [ios-skill-installed.png](reference/ios-skill-installed.png)). A catalogue entry is an icon, a name, its source host, and one sentence. It lists what it includes (here one connector and five skills, each with its name and the "Use when..." trigger from the skill's frontmatter) with a View source link to the repository. The primary action toggles between Add and Added, and the overflow menu holds Uninstall.

**Accounts on a connector** ([ios-skill-add-account.png](reference/ios-skill-add-account.png)). A connector can hold several accounts, each labelled by the user ("work or personal") and marked Connected once its OAuth flow completes. Add Another Account opens an inline label field with Authorize and Cancel. This is the per-account, shared-across-bots model Phase 5 needs, and it is the shape the hub's single `COMPUTER_MCP_URL` has to grow into.

**Bot profile** ([ios-bot-profile.png](reference/ios-bot-profile.png), [ios-bot-instructions.png](reference/ios-bot-instructions.png)). A Bot is a name, an optional title, and a mark: one of eleven colours and one of eight shapes, with a reset to default, and the mark is how the Bot appears everywhere. Below that are its instructions (a single free-text field), its routines (a list with Add routine), and a notifications toggle, with delete in the overflow menu. The example is a Receptionist whose whole instruction is to be front of house: route work to the right specialist bot and stay at the desk, never do the specialist work itself. Everything on this page is also set up through chat: telling a Bot its title, rewriting its instructions, or asking for a routine edits the same profile, so the settings page is a view of the Bot's files rather than the only way to change them.

What the web client takes from this: the chat is the centre and the desk is a drawer (Phase 2); task cards are a message part with a PR link and a delta, built from the transcript (Phase 7's action log is the same data); the skills catalogue reads the Eve project and the connector registry, and accounts are stored per user, not per bot (Phase 5); a Bot's name, title, mark, instructions, and routines are files on the box (`profile.json`, the Eve instructions, `agent/schedules/`) that both the settings page and the Bot itself can write, which is what makes chat-driven setup and Phase 4's routines table the same feature; and a front-of-house Bot that delegates to specialists is the first multi-agent shape to build (Phase 7).

## 3. Roadmap for the web clone

Ordered so each step ships on its own and the security gaps close first.

**Phase 0, make one deployment safe (this PR + P0 items in [AUDIT.md](AUDIT.md)).** Email allowlist; secrets as Fly secrets; scrubbed shell environment; token revoke and expiry; hub UID split on the guest.

**Phase 1, one voice.** Pick one of: (a) render the hub occurrence log in the web client (`Seat.Occurrences` paged, `ProvideSecret` masked field, a new `Seat.AnswerWidget`), and have Eve's `send_message` be the only text that reaches the human, which is Grok's actual behaviour; or (b) delete the voice subsystem and lean on Eve's native message parts and input requests, adding only a masked-secret input kind. (a) is faithful and keeps the harness swappable; (b) is smaller. Whichever it is, stop maintaining both.

**Phase 2, bots as the unit of the UI.** A left sidebar of bots from `GET /roster` with profile (name, title, avatar from `profile.json`), "New bot" calling `CreateBot` and scaffolding an Eve project from a template, per-bot chat and per-bot screen, unread and `WAITING` badges, sections and pinning stored per user. The current desktop pane becomes the "Agent Computer" drawer opened from a chat, not the page's centre.

**Phase 3, approvals and takeover, properly.** One approval model: hub policy rules and Eve approvals rendered as the same card with Allow once / Always allow (persisted per bot as a policy rule) / Deny, showing the action (argv, URL, coordinates with a screenshot crop). Takeover: distinguish "pause the bot" from "take the seat", show who holds it, confirm hand-back, notify (title flash, Web Push) when a screen goes `WAITING` in a background tab.

**Phase 4, routines.** A routines table per bot (cron in the user's timezone, enabled, last 20 runs with status and the transcript slice), "Test run", auto-pause after N failures. Backed by Eve schedules generated from a JSON file the hub owns, so the UI edits data rather than code. Event triggers later (a webhook endpoint on the hub that wakes a bot with `[inbound]`).

**Phase 5, skills and connectors.** `/` in the composer lists the bot's skills; a per-bot toggle; a skills page that reads the Eve project. Remote MCP connectors with OAuth stored per account, shared across bots, surfaced in the same catalogue.

**Phase 6, one computer per account.** Seeded tenants are in (`matt`, `vcmc`, one Fly app and volume each, session bind + per-computer Pair). Still missing: a Fly Machine per user provisioned on first sign-in (Machines API from the web server), the seat token scoped so it cannot provision, idle suspend and wake-on-request through an always-on edge that can proxy WebSockets and SSE.

**Phase 7, files, memory, audit, multi-agent.** File cards with preview and upload; a memory page that edits `memory/profile.md`; an action log built from the transcript plus hub tool calls; bot-to-bot messages and group chats once Phase 2's roster is stable.

Throughout: keep `api/DESIGN.md` the contract, keep the model's tool surface at five, and keep every human input path through the seat.
