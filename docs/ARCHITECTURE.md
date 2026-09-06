# Architecture

Date: 2026-09-03, against `main` at `3279575`. Scope: the whole system as it is deployed, the seams that are load-bearing, and the shape the next few changes are aimed at. Companion to [`AUDIT.md`](AUDIT.md) (what is broken and ranked) and [`WHATSAPP-PARITY.md`](WHATSAPP-PARITY.md) (the order of work). This document answers a different question from either: not what to fix and not what to build next, but why the pieces are cut where they are, so that a change lands on the right side of a boundary.

Written while eight branches were in flight and revised once they landed, so everything below describes `main` as it now is: [#26](https://github.com/mblode/expert/pull/26) (one principal model and `Seat.Issue`), [#27](https://github.com/mblode/expert/pull/27) (fail closed on the computer binding), [#28](https://github.com/mblode/expert/pull/28) (one supervised Eve launch path), [#29](https://github.com/mblode/expert/pull/29) and [#31](https://github.com/mblode/expert/pull/31) (one outbound WhatsApp envelope and the tool for it), [#33](https://github.com/mblode/expert/pull/33) (a redeemed invite is a scoped seat), [#34](https://github.com/mblode/expert/pull/34) (conversations). Each is named where it touched this text.

## 1. Two planes

There is a shared control plane and there are single-tenant computers, and almost every design question in this repository is really a question about which of the two owns a thing.

The control plane is `apps/web`, a Next.js app on Vercel serving hello.expert. It holds identity (Better Auth over a Drizzle adapter in `apps/web/lib/auth.ts`), the database (libSQL/Turso in `apps/web/lib/db.ts`, with `user`, `session`, `computer`, `computer_seat` and `invite` tables), the catalog of which computers exist, and the setup code for each one. It holds no pixels, no files, no agent and no model call. It is a directory and a credential broker.

A computer is one Fly Machine with one volume, one hub, one desk, one Eve process per Bot and one WhatsApp bridge. Blode is `mblode-computer` (`fly.toml`), Vibey is `vcmc-computer` (`fly.toml`), both shared-cpu-2x with 2 GB, both suspending to zero when idle. The Machine is the unit of isolation, the unit of billing, the unit of failure and the unit of deploy, all at once, and that coincidence is the reason the architecture stays this simple.

PID 1 on the guest is `apps/hub/src/host/init.ts` running under tini via `deploy/fly/guest-entrypoint.sh`. It is the only process on the box that changes uid: it fixes up the volume, mints or refuses to mint the setup code, writes the hub-owned secrets at 0600, then hands everything to `host/supervisor.ts`, which starts `desk-up` once as `box`, one `eve start` per roster Bot as `box`, the bridge as `hub` and the hub as `hub`, each with a restart backoff (1 s to 30 s, reset after 60 s stable) and an optional health probe. The supervisor mirrors its view to `/run/computer/status.json` and `GET /healthz` reports it, so a Machine with a dead X server no longer answers `ok`. Note the asymmetry in that health check: `ok` reflects every child, but the endpoint is always HTTP 200 while the hub itself answers, deliberately, so that a crash-looping Eve does not make Fly restart the whole Machine.

There is one process in the system that is not on a computer and not on Vercel: `apps/clock`, a 256 MB always-on Fly Machine (`fly.clock.toml`) that exists because suspend-to-zero and scheduled work are in direct conflict. A suspended guest has no clock, so its routines cannot fire, and every fix inside the guest is circular. The clock reads the Bots' routine manifests out of its own image and GETs each computer's public `/healthz` three minutes before a routine minute, which Fly Proxy serves by starting the Machine; the guest's own alarm then wakes the Bot and the Bot fires the routine. It holds no credential and calls no other route, so the whole of its authority is "may start a computer". The cron it evaluates is `packages/shared`, the same code the guest uses, because two implementations would disagree eventually and the disagreement is silent.

The uid split is the other half of that. The hub used to run as `box`, which meant the model's `shell` could read the roster, the seat tokens and the Baileys credentials, because they were all readable by the user the model runs as. Now `/workspace/.computer` is hub-owned at 0700 and the hub reaches the desk through `sudo -u box` (`asBox` in `apps/hub/src/desk/docker.ts`, enabled by `COMPUTER_RUN_AS`). `init.ts` also strips `COMPUTER_SETUP_CODE`, `WHATSAPP_BRIDGE_SECRET` and `FLY_API_TOKEN` from every child environment, because Eve shares uid `box` with the model's shell and anything in Eve's environ is the model's too.

```mermaid
flowchart TB
  browser["Browser: apps/web/app-shell.tsx<br/>desk pane, chat pane"]

  subgraph control["Control plane: hello.expert on Vercel (apps/web)"]
    auth["Better Auth + Turso<br/>lib/auth.ts, lib/db.ts"]
    catalog["Catalog and binding<br/>lib/computers.ts, lib/computer-seat.ts"]
  end

  subgraph machine["One Fly Machine per tenant (fly.toml)"]
    init["PID 1: host/init.ts + host/supervisor.ts"]
    hub["hub :8080<br/>handler to service to desk"]
    eve["eve start :2000 per Bot<br/>apps/eve"]
    bridge["whatsapp-bridge (Railway)<br/>vcmc-agent/bridge"]
    desk["desk: Xvfb, x11vnc, Chromium<br/>hub/src/desk/docker.ts"]
  end

  wa["WhatsApp, Baileys socket"]

  browser --> auth
  auth --> catalog
  catalog -->|"Seat.Pair with the setup code"| hub
  browser -->|"seat token: Seat RPCs, /eve/v1, /vnc"| hub
  wa <--> bridge
  bridge -->|"POST /connectors/:id/message, x-connector-secret"| hub
  hub -->|"/eve/v1/:kind/..., x-computer-eve-secret"| eve
  eve -->|"Agent RPCs, bot token"| hub
  hub -->|"sudo -u box, XTEST"| desk
  init --> hub
  init --> eve
  init --> bridge
  init --> desk
```

Two things in that picture are easy to misread. The browser talks to the hub directly, cross-origin, not through Vercel: the control plane hands out a seat token and then gets out of the way, which is why `corsHeaders()` in `apps/hub/src/handler/router.ts` is `*` and why every hub call is bearer-authenticated with nothing reading cookies. And Eve is a child of the guest that calls back into the hub over loopback with its own bot token; it is not a peer service and it is not addressable from outside.

## 2. The account is the tenant boundary

`apps/web/lib/computers.ts` binds an email address to one computer. `COMPUTER_BINDINGS` is a `email:computerId` list, `parseComputerBindings` reads it, `boundComputerId` resolves an address to a computer id and `accessibleComputers` decides what the switcher may show. Both fail closed, and that is the whole point of them: an address with no binding and no `DEFAULT_COMPUTER_ID` gets **no** computer rather than falling back to Blode, and an unset `COMPUTER_OPERATOR_EMAILS` means nobody may switch. An account nobody remembered to bind sees "No computer is configured for this account", which is the intended answer: the alternative was landing it on someone else's Machine and Pairing an owner seat there with that Machine's setup code. `computer-seat.ts` then Pairs that computer's hub with its own setup code (`COMPUTER_SETUP_CODE` for Blode, `COMPUTER_SETUP_CODE_VCMC` for Vibey) and stores the resulting seat token in `computer_seat`, keyed by user, so a later session reuses the token instead of Pairing again.

The consequence people get wrong: Vibey is a separate login on a separate Machine, not a Bot on Blode. A second Bot would put the VCMC agent in the same `/workspace`, under the same box user, driving screens of the same desk (see section 3). A second computer is a second Fly app, a second volume, a second setup code and a second hub. That is the only boundary in the system that actually holds, so anything that needs separation buys a Machine.

Both lookups used to fail open, and it was the most consequential correctness gap in the control plane. `defaultComputerId` fell back to a hardcoded `"blode"` for any address with no binding, so an address that passed `AUTH_ALLOWED_EMAILS` but that nobody remembered to bind landed on Blode and Paired an owner seat there; and `isComputerOperator` treated an unset `COMPUTER_OPERATOR_EMAILS` as every signed-in user, so in the default configuration everyone was an operator, `accessibleComputers` returned the whole catalog and the binding branch never ran at all. [#27](https://github.com/mblode/expert/pull/27) closed both together, because fixing either alone leaves the hole open: no binding now resolves to nothing rather than to Blode, an unset operator list means nobody, and `DEFAULT_COMPUTER_ID` survives only as an explicit opt-in. The deploy consequence is worth knowing before the next sign-in: an address not in `COMPUTER_OPERATOR_EMAILS` sees only its bound computer.

There is a structural fact underneath that, still true: the Vercel deployment holds the setup code for every computer in the catalog, and a setup code is a permanent, unrotated owner credential for that Machine. The blast radius of the control plane is therefore every tenant on it. `Seat.Issue` from [#26](https://github.com/mblode/expert/pull/26) is what shrinks it, by letting a control plane hold an `issuer` grant that hands out working seats and can never mint an owner. The web does not hold one yet: [#33](https://github.com/mblode/expert/pull/33) pairs per grant, spends that owner on a single `Issue` and revokes it in the same request, which removes the stored owner but not the stored setup code. Migrating to a stored issuer is the change that finishes this, and it closes the one window #33 leaves, where a crash between `Pair` and `Revoke` strands an unexpiring owner in `seats.json`.

## 3. A Bot is not a security boundary

`apps/hub/src/service/bots.ts` says it in the type comment, and the code means it literally: "One shared box, many Bots, one screen (window index = X display) per Bot. The agent token identifies the Bot; the Bot maps to its display hub-side. Bots are not security boundaries: same box user, shared /workspace." Policy is constructed once and passed to every Bot for the same reason.

So what a Bot actually separates is a screen, a token, a state directory (`/workspace/.bots/<id>`) and an Eve process. What it does not separate is the filesystem, the box user, browser profiles, installed packages or anything either agent can read with `shell`. Two Bots on one computer can read each other's transcripts and each other's files, and `AUDIT` P1 #9 records the sharpest version of that: any Bot can write another Bot's `transcript.jsonl` and the voice service trusts every line it restores.

The useful way to hold this is that a Bot is an org-chart noun, not a security noun. Splitting work across Bots buys parallel screens and separate conversations. It buys nothing at all against a compromised or misled agent. Anything that needs real separation is a separate account on a separate computer, which is exactly the shape Vibey already has.

## 4. The doors

Everything that reaches a tenant computer goes through the hub on `:8080`, and there are seven ways in. The router (`apps/hub/src/handler/router.ts`) refuses to register a method without an auth policy and `assertAllPolicies()` fails startup if any proto method is unregistered, so the list below is closed by construction rather than by review.

| Door              | Path                          | Credential                                                   | Checked in                                            |
| ----------------- | ----------------------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Pair              | `POST /computer.v1.Seat/Pair` | the computer's setup code                                    | `AuthRegistry.pair`, ten failures then a 60 s lockout |
| Seat RPCs         | `POST /computer.v1.Seat/*`    | a seat token carrying a role                                 | `AuthRegistry.verify`, policy `seat`                  |
| Agent RPCs        | `POST /computer.v1.Agent/*`   | a bot token from the roster                                  | `AuthRegistry.verify`, policy `agent`                 |
| Eve proxy         | `/eve/v1/*`                   | an owner seat token; the hub injects the Eve secret          | `handler/eve-proxy.ts`, `auth.isOwner`                |
| Connector ingress | `POST /connectors/:id/:path`  | `x-connector-secret` (`x-channel-secret` still accepted)     | `handler/connectors.ts`, `ConnectorRegistry.verify`   |
| Pixels            | `GET /vnc*`, the WS upgrade   | a 15 minute pixel token bound to a display, or an owner seat | `app.ts`, `auth.canViewPixels`, `vnc-proxy.ts`        |
| Public            | `GET /spec`, `GET /healthz`   | none                                                         | `router.extra`, policy `public`                       |

A few properties of that table are worth stating outright because they were each paid for.

**Pair is the one unauthenticated write**, and it hands back a permanent owner token. The lockout stops online guessing and the 1 MB body cap stops a dump, but one correct guess is still an owner credential nobody rotates (`AUDIT` P0 #10).

**Agent tokens are compared constant-time against every roster entry with no early exit on match**, and the roster is read through a closure (`agentTokens: () => bots.tokenEntries()`) so provisioning a Bot at runtime needs no auth-registry sync.

**A role is a set of methods, and `methods` narrows one but can never widen it.** `owner` is unrestricted inside the Seat service, so an RPC added tomorrow reaches owners the moment it is registered; every narrower role is an explicit allowlist, so the same RPC stays denied to them until someone lists it. That asymmetry is the point, and `principalAllows` intersects the two lists rather than letting a grant replace the role's, which is how an `issuer` that may not hand out an owner is stopped from asking for an `operator` that names `CreateBot`. This is also how `/roster` ends up owner-only in effect despite being registered with policy `seat`: it is not in the narrower allowlists, so those roles are refused by the same check that guards the Seat RPCs.

**A guest seat is bound to one screen and always expires**, capped at `GUEST_MAX_TTL_MS` of four hours, which is deliberately the same number as `MAX_INVITE_TTL_MINUTES` in the control plane so a seat cannot outlive its link from either end. Expiry is checked on read, so a stopped sweep cannot extend one.

**For most of this system's life, nothing on the wire minted a guest.** `mintGuest` had no production caller, and the invite flow WhatsApp members are meant to use (`apps/web/lib/invite.ts`, `grantInviteSeat`) called `pairComputer`, which is `Seat.Pair` with the setup code. Redeeming a desk invite therefore handed a group member a full owner seat on the tenant hub, expiring by the web-side invite record and not by the seat itself: the mechanism for scoped seats existed and the path that needed it did not use it. [#26](https://github.com/mblode/expert/pull/26) built the minter that reaches the wire and [#33](https://github.com/mblode/expert/pull/33) made the invite path call it, so a desk link now redeems to a guest bound to one screen for the link's own remaining life.

**A narrowed owner is not an owner at the doors an allowlist cannot name.** Authoring a connection file needs `CreateBot`, and no role but `owner` carries it, so a plugins invite mints an owner narrowed by `methods` to two RPCs for two minutes. `/eve/v1`, `/roster` and the pixel stream are HTTP routes rather than RPCs, so nothing in a `methods` list can describe them; `AuthRegistry.isOwner` therefore refuses any owner record carrying `methods`, or that grant would inherit all three. The cleaner fix, still open in `AUDIT.md`, is a role that may provision and nothing else.

**The connector ingress deliberately has no lockout**, unlike Pair, and the comment in `service/connectors.ts` explains why: connector ids are guessable (`whatsapp-<acct>`), the route is public, so a per-id lockout would let anyone on the internet block the real bridge for a minute at a time with ten junk requests. A 256-bit secret compared in constant time is the whole defence.

**The two Eve doors end at the same place with the same header.** Both the seat-gated proxy and the connector ingress forward to the Bot's Eve on loopback with `x-computer-eve-secret`, so an Eve channel file cannot tell them apart and does not need to. They differ only in the question they ask on the way in: the proxy asks "is this the owner", the ingress asks "is this the door it claims to be".

## 5. `connector` and the two senses of `channel`

The word `channel` was overloaded across three genuinely different objects, and one of them has been renamed:

1. **A credentialed door on the hub, now a `connector`.** `apps/hub/src/service/connectors.ts` and `connectors.json`: a record with an id, a kind, a Bot, a secret and an optional path allowlist. `POST /connectors/<id>/<rest>` with `x-connector-secret` forwards to that Bot's Eve at `/eve/v1/<kind>/<rest>`.
2. **An eve route file, still a `channel`.** `apps/eve/lib/channels/whatsapp.ts`, a `defineChannel` with routes, an auth check and a turn policy. The file stem is the channel id in eve's own sense, and the connector record's `kind` is what selects it. This is a framework concept from the eve dependency; renaming it would not compile.
3. **The conversational sense, still a `channel`.** "WhatsApp is just a channel", the way `WHATSAPP-PARITY.md` uses it in its noun table: a way messages reach a Bot and replies leave it.

Senses 1 and 2 still line up by convention (`kind: "whatsapp"` finds `channels/whatsapp.ts`) and nothing enforces the correspondence; a record naming a kind with no route file gets a 404 from Eve rather than a hub-side error. That is tolerable. What was not tolerable long-term is that sense 1 is a _credential_, and calling a credential a channel made every sentence about revocation ambiguous. Senses 2 and 3 keep the word because they are the same idea at two altitudes.

`connector` does not absorb `plugin`. `WHATSAPP-PARITY.md` spends that neighbouring word on a remote MCP or OpenAPI connection with a human-consented credential: a connector is inbound and hub-minted, a plugin is outbound and human-consented, and the credential points the opposite way in each. Keeping them apart is why `service/connectors.ts` says so in its header comment rather than leaving it to a reader's memory.

**The rename is a migration, and the compatibility aliases are the migration.** `channels.json` is on both deployed Fly volumes, and a bridge deployed before the rename posts `/channels/<id>/message` with `x-channel-secret`. Renaming outright would have cut WhatsApp off at the moment of deploy and left the volume's secret unread, which takes a tenant down until someone re-provisions the number by hand. So three aliases shipped with it:

- The ingress answers `/connectors/` and `/channels/`, and takes `x-connector-secret` or `x-channel-secret`. Either half in either spelling opens the door, so a half-deployed pair works.
- `FileConnectorStore` reads `connectors.json`, falling back to `channels.json` when there is none. It writes only the new name, so the first mutation migrates the content forward, and nothing deletes the old file: a destructive step on deploy is exactly what the fallback exists to avoid, and it leaves a rollback artifact.
- The bridge's `accounts.json` still parses `channel_id` / `channel_secret` alongside `connector_id` / `connector_secret`, for the same reason: a parse error there is a bridge that will not start, which is every linked number down.

The bridge itself sends only the new names; Blode is gone (2026-09-06) and the aliases in this repo's code went with the audit pass, so what remains is the bridge's own tolerance of the old keys. On the wire, `WhatsAppAccount.channel_id` became `connector_id`; no client in this repository read it.

## 6. The model's voice, and where it actually comes out

The intended contract, from `api/RESEARCH.md` and `api/DESIGN.md`, is that plain model text is a private scratchpad and the human sees exactly the occurrences the model chose to send. `apps/hub/src/service/voice.ts` implements that faithfully: `Agent.SendMessage` appends an occurrence, `widget` and `secret_request` end the turn, a second send after the turn ended is a `CONFLICT`, and the turn re-opens only when the human does something. `Seat.Occurrences` pages the log and it survives a restart through the Bot's `transcript.jsonl`.

The product did not use it, and still does not. Grepping for consumers turns up none: `apps/web/components/chat-pane.tsx` renders Eve's own session stream through `useEveAgent` over the `/eve/v1` proxy, and `apps/ios/Computer/Models/EveClient.swift` speaks the same Eve protocol through the same proxy. Neither client calls `Seat.Occurrences`, neither answers a widget, neither calls `ProvideSecret`. So the model's voice has **two exits and one dead end**:

- **The Eve session stream**, proxied at `/eve/v1` and gated on an owner seat, is what a human on hello.expert or iOS actually reads. It carries the model's raw assistant text, tool parts and reasoning, which is the opposite of the scratchpad contract.
- **The WhatsApp channel's synchronous `{reply}`**, in `apps/eve/lib/channels/whatsapp.ts`: the bridge POSTs a message through the hub's connector ingress, the channel drains the session's event stream to the last `message.completed`, normalises it in `outboundReply` and returns it in the HTTP response the bridge posts back to the chat. One turn, one reply, no thread on the hub side at all. The session token is `<chat jid>#<uuid>`, deliberately unique per message, so there is no in-thread conversational memory either: the agent grounds itself in the bridge's recent-message context instead.
- **The occurrence log**, written by `send_message` (`apps/eve/lib/tools/send_message.ts`), persisted per Bot, read by nobody.

This is `AUDIT` P1 #4 seen structurally rather than as a bug, and it is the reason a dead-end writer turned out to be cheap to repoint: with no client cursor, no polling loop and no UI, the only real migration is the `transcript.jsonl` sitting on two Fly volumes.

[#34](https://github.com/mblode/expert/pull/34) took the first cut, following [`plans/conversations.md`](plans/conversations.md). A **conversation** is now a hub object with a route, participants and an ordered log: the index in `conversations.json`, one append-only JSONL per conversation, both under `/workspace/.computer` at 0700 where the model cannot write them, which is the other half of `AUDIT` P1 #9. The connector ingress resolves an inbound `{acct, jid}` to a conversation and mints a **turn token** bound to it; the token rides to Eve as `x-computer-turn`, comes back on `Agent.SendMessage`, and the hub appends where it says. The model never sees it and cannot mint one, so the conversation is addressed without widening the five tools. No turn token still means the Bot's `seat` log, byte for byte as before.

Turn state moved with the log, which quietly fixed a real bug: a request waiting on hello.expert used to make the next WhatsApp `send_message` return `CONFLICT`, because one Bot had one `turnEnded` flag.

**Decided 2026-09-06.** The conversation log is the record and the live surfaces read what they can render: WhatsApp gets the synchronous reply, hello.expert renders the Eve stream and the work page reads `Conversations` and `Occurrences`. The voice is not a parallel channel any more, it is `send_message` plus one rule. `widget` is gone: no client rendered one, no RPC could answer it, and a question with choices is text on every surface. `secret_request` stays because it is the safety design the README promises, and hello.expert now answers it with a masked field that calls `Seat.ProvideSecret`, so a Bot that asks for a 2FA code is no longer talking to a wall.

What is deliberately still open. The WhatsApp reply is still the synchronous `{reply}` in the response body, because `handleSend` in the bridge refuses group JIDs structurally and async group delivery needs a signed reply capability first; the conversation is the record, and delivery stays per route. The `transcript.jsonl` import, `Seat.Conversations`, and bot-to-bot are staged after the tracer. And the question underneath all of it is untouched on purpose: whether Eve's stream stays a human-facing surface or goes back to being the private scratchpad `DESIGN.md` describes is a product decision with a UI rewrite attached, and burying it inside a hub change is how it would get taken by accident.

## 7. What is deliberately not there

Each of these is an absence someone will propose filling. Each has a trigger that would make it worth doing, and until that trigger fires, adding it is a cost with no return.

**A gateway.** Nothing sits in front of the hub. The browser calls the Fly Machine directly with a bearer token; Vercel's own API routes (`/api/computer/select`, `/api/computer/reconnect`, `/api/invite`, `/api/connections`) manipulate the binding and mint invites, they do not proxy hub traffic. This keeps VNC frames and Eve's event stream off Vercel entirely, which is the whole reason it is shaped this way. _Trigger:_ a tenant that must not expose a public hostname, or a per-tenant rate limit that cannot live on the Machine. Not "it feels tidier".

**Egress policy.** A guest reaches the whole internet. `data/policy.json` gates what the model may _run_, and nothing gates where the traffic may _go_: a box with Chromium, `shell` and a signed-in browser profile is an exfiltration path that no approval rule sees, because the approved command and the malicious one look identical at the point of approval. Cursor ships this as Network Controls, destination allowlists in four modes, and it is the one thing on their security page we have no answer to at all. The reason it is absent rather than half-built is that the honest version is not a config file: allowlisting by hostname does not survive contact with DNS, so it wants resolved-address sets or an authenticating egress proxy the guest is forced through, plus a carve-out for the AI gateway, the hub's own Fly API calls and package registries, each of which is a hole the size of the thing being prevented. _Trigger:_ the first tenant whose data is not their own, or a Bot that runs unattended against a browser profile the owner cares about. Rolling our own substrate would have forced this early, since the TAP device and the NAT would have been ours; on Fly it has to be chosen.

**An MCP server.** The hub does not speak MCP and `api/DESIGN.md` argues at length against the fat-MCP shape: the model's surface is five tools with one closed action union, not sixty-four tools. Eve is an MCP _client_ when `COMPUTER_MCP_URL` is set (`apps/eve/lib/connections/local.ts`), which is the direction that adds capability without widening the attack surface. _Trigger:_ a third-party harness that must drive this computer and cannot be given a bot token. Note what that implies: an MCP server would be a new door in section 4's table and needs a row there before it needs an implementation.

**Tenant tables and self-serve provisioning.** Partly present, and worth being exact about. The `computer` and `computer_seat` tables do exist in Turso, and `ensureComputerCatalog()` mirrors the catalog into them. But the catalog itself is seeded from environment variables in `computersFromEnv`, with `blode` and `vibey` written into the source, so `computer` is a cache of a hardcoded list rather than a table you can insert a tenant into. Adding a tenant today is a Fly app, a volume, a setup code and a code change, and only the first three are automated: `apps/hub/src/host/fly-provision.ts` creates the app, the volume and the Machine, so `fly-machine.ts` is no longer only able to wake something someone else made. Making the list itself configurable was tried and reverted, because a second environment variable describing tenants beside `COMPUTER_BINDINGS` is a setting to maintain in exchange for a code change nobody has had to make yet. _Trigger:_ the third tenant, or the first tenant who is not a person Matt knows. At that point the catalog becomes rows, which turns `computersFromEnv`, `boundComputerId`, `accessibleComputers` and both invite paths async at once and should ride alone; and the Fly token needs a home, which is not Vercel, because a credential that can destroy every Machine in the org does not belong in the deployment that already holds every tenant's setup code. Section 2's fail-closed binding had to be in place first, and since [#27](https://github.com/mblode/expert/pull/27) it is: self-serve provisioning on top of a fail-open binding is how one account opens another account's box. See [`plans/gateway.md`](plans/gateway.md).

**An adapter split.** `service/adapters.ts` (OpenAI, Claude and Gemini action shapes) was deleted in the audit pass because it had no route, and the mapping rules live in `api/RESEARCH.md` instead. The hub speaks exactly one action union and clients translate. _Trigger:_ a second first-party client with a shape the hub cannot serve. A harness that can be configured is not that trigger.

**SQLite for hub state.** The hub's state is JSON files on the volume: `bots.json`, `seats.json`, `connectors.json`, `policy.json`, each written through `writeTokenFile` at 0600 with a temp-file rename. There are a handful of records in each, they are edited by hand and by `npm run bot`, and `ConnectorRegistry` reads its file per call precisely so an out-of-band edit is picked up by a running hub. _Trigger:_ concurrent writers, or a query that is not "read the whole file". Both arrive together with per-principal grants and an audit trail, which is why [#26](https://github.com/mblode/expert/pull/26) explicitly keeps the storage as it is and says so: folding the stores together is mechanical once every caller speaks `Principal`, and burying a storage migration inside an auth rewrite makes the diff unreviewable.

## 8. The target shape

The direction is one identity model, one conversation, and a tenant that can be created rather than declared. Nothing here is speculative architecture: every box below is either an existing file or the named change in an open PR.

```mermaid
flowchart TB
  subgraph control["Control plane (apps/web)"]
    idp["Better Auth + Turso"]
    tenants["Tenant rows, not a seeded catalog<br/>fail closed per #27"]
    issuer["issuer grant, not the setup code<br/>Seat.Issue per #26"]
  end

  subgraph machine["Tenant Machine"]
    principals["One PrincipalRecord, one verify()<br/>roles as method sets, #26"]
    convo["One conversation object<br/>one identity, one cursor"]
    connectors["Connectors: inbound doors<br/>service/connectors.ts"]
    plugins["Plugins: outbound credentials<br/>hub-owned, consented on the web"]
    hub2["hub: handler to service to desk"]
    eve2["Eve per Bot"]
    desk2["desk: one screen per Bot"]
  end

  idp --> tenants
  tenants --> issuer
  issuer -->|"issue a scoped seat, never an owner"| principals
  principals --> hub2
  connectors -->|"WhatsApp, webhooks, Slack"| convo
  convo -->|"web, iOS, WhatsApp read the same thread"| principals
  hub2 --> eve2
  eve2 --> plugins
  hub2 --> desk2
```

Read in order, the moves were: make the binding fail closed (#27) so that identity means something; give the hub one principal model with roles and a way to issue a scoped seat (#26) so that "a human at a screen" stops meaning "an owner of the box", then make the invite path actually use it (#33); and collapse the conversation shapes of section 6 into one object so that a reply is a reply whatever carried it, which #34 has started. What is left, in order: finish the conversation record (import the transcripts, `Seat.Conversations`, per-conversation turn state everywhere); rename the inbound door to `connector` once `plugin` is settled as the outbound one; move the control plane from a stored setup code to a stored `issuer`; and only then turn the catalog into tenant rows, because a provisioning API on top of the current binding is a hole rather than a feature.

Two invariants survive all of it, and a change that breaks either is wrong even if it is smaller. The hub is the only door and the only gate: every inbound message, every human input and every model action crosses it, so a path that bypasses the hub also bypasses policy, the seat FSM, suspend and wake, and the audit trail. And the Machine is the only isolation boundary there is: a Bot, a role, a seat and a connector all narrow what someone may do on a box they are already on, and none of them keeps them off it.
