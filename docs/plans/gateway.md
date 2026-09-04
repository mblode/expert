# The gateway: one always-on host, tenants that suspend

Plan date: 2026-09-03. Companion to [`ARCHITECTURE.md`](../ARCHITECTURE.md) (why the pieces are cut where they are) and [`WHATSAPP-PARITY.md`](../WHATSAPP-PARITY.md) (the order of WhatsApp work). This document answers one question those two leave open: what it takes for Expert to spin a computer up per user rather than declare one per person Matt knows, and what the WhatsApp socket does about it.

## 1. The problem, stated once

`fly.toml` records the trade in a comment: "A linked WhatsApp number needs the socket up, so linking one on this tenant means `auto_stop_machines` off and `min_machines_running` 1: suspend-to-zero is gone for that tenant, and that is the price of the socket living here rather than on a second host."

That price is fine for two tenants and wrong for a platform. Suspend-to-zero is what makes a dormant computer cost a volume a month instead of a machine a month, and it is the single reason per-user computers are affordable on Fly at all. A design where every tenant with a phone number is pinned always-on gives that up for exactly the users who are most engaged.

So: move the socket to one always-on low-spec host, and let every tenant computer suspend. The socket host is the only thing that never sleeps.

## 2. What that costs, honestly

[`WHATSAPP-PARITY.md`](../WHATSAPP-PARITY.md) section 3 considered a shared gateway and rejected it, for three reasons that are all still true. They are worth reading as a work list rather than a veto, because the thing being bought (suspend for every tenant) was not on the table when they were written.

**"It puts a cross-tenant boundary in application code."** It does, and that boundary is now built: each account carries its own `bridge_secret`, the presented credential resolves to a principal before any route runs, and `acct` comes from the credential rather than the request. Previously one process-wide secret opened every account and `acct` was a query parameter, so any holder could read any account by naming it. See `apps/whatsapp-bridge/src/server.ts`.

**"One crash takes every number down."** Still true, and the mitigation is that the bridge is already one `makeWASocket` per account with per-account boot failures logged rather than fatal. What is missing is per-account restart: today a process-level crash takes the lot. The supervisor pattern in `apps/hub/src/host/supervisor.ts` is the shape to copy.

**"It needs the public ingress and per-tenant secrets that the per-Machine layout avoids."** The public ingress turns out to exist already. `handleConnectorIngress` never looks at the peer address: `/connectors/<id>/message` is served on the hub's public port and gated on `x-connector-secret`, compared constant-time. Pointing the bridge at `https://<tenant>.fly.dev` instead of loopback needs no hub change at all, only the per-account `hub_url` that now exists.

There is a fourth cost the original list did not name, and it is the sharpest one. **Today a compromise of a tenant's box costs that tenant's WhatsApp identity; on a shared gateway it costs everyone's.** Against that, the gateway removes Baileys credentials from every box a model can run `shell` on, which is the other half of the same threat. The trade is: fewer hosts hold credentials, and the ones that do hold more. Take it deliberately, and keep the gateway free of anything tenant-facing.

## 3. The shape

```
WhatsApp                     one always-on gateway Machine (shared-cpu-1x, 1-2 GB)
   │  Baileys, one socket      ┌───────────────────────────────────────┐
   └──────────────────────────►│ whatsapp-bridge                       │
                               │   accounts.json: acct -> bot,         │
                               │   connector_secret, bridge_secret,    │
                               │   hub_url                             │
                               │ provisioner (holds the Fly token)     │
                               └──────┬────────────────────────────────┘
                                      │ POST https://<tenant>.fly.dev/connectors/<id>/message
                                      │ x-connector-secret        ← wakes a suspended tenant
                                      ▼
                    tenant Machines, each suspending to zero when idle
                    hub :8080 -> Eve -> desk, exactly as today
```

Three things about that arrow are load-bearing.

**It must be the public hostname.** Fly Proxy is what starts a stopped or suspended Machine and holds the connection while it resumes. The private 6PN address does not: a request to `<app>.internal` reaches a hibernated tenant as a connection error, not as a wake. `AccountRecord.hub_url` says so where someone will read it.

**Resume latency lands on the message.** A suspend resume is well under a second and a cold start from stopped is a few seconds; the bridge's `AGENT_TIMEOUT_MS` is 40 s and its retry policy already treats a transient failure as retryable, so neither needs changing. Worth re-checking once real numbers exist.

**Nothing tenant-specific lives on the gateway except the socket.** No model, no desk, no volume a Bot can write. The gateway holds Baileys credentials, the accounts file, and the Fly token; everything else stays on the tenant's own Machine and volume.

## 4. Sizing

Budget 150-200 MB per linked account with `SYNC_FULL_HISTORY=false`, so 1 GB holds around five numbers and 2 GB a dozen. Turn full history sync off on a shared gateway: it is a per-account memory spike at link time, and on one host those spikes coincide.

The gateway is the only always-on cost for the whole platform. A dormant tenant costs its volume, which is a few tens of cents a month, and nothing else.

## 5. Fly as the platform

Fly's Machines API creates apps, volumes and Machines; `fly deploy` is a client of it, not a privileged path. `apps/hub/src/host/fly-provision.ts` is that call in the app-per-tenant shape the repo already uses: one app, one volume, one Machine, one `<app>.fly.dev` hostname.

App-per-tenant rather than machine-per-tenant-in-one-app, because Fly's secret store is per app and this design leans on it: `init.ts` refuses to mint a setup code on a cloud deployment precisely because the platform is meant to hand it one. A shared app would put every tenant's setup code in one namespace, which is the blast radius section 2 of `ARCHITECTURE.md` is already trying to shrink.

Two Fly facts to plan around. Org quotas on apps and Machines exist and are raised by asking support, so find the ceiling before a launch rather than during one. And a suspended Machine bills no CPU or RAM but its volume bills continuously, so a signed-up-and-never-returned user has a small permanent cost: that is the number that decides whether dormant tenants get destroyed and re-created or kept.

## 6. Where the Fly token lives

Not on Vercel. `ARCHITECTURE.md` section 2 already notes that the control plane holding every tenant's setup code makes its blast radius the whole fleet; adding a token that can create and destroy every Machine in the org makes that worse, and Vercel has no `/.fly/api` socket so it would have to be a real org token in an environment variable.

Put it on the gateway. The always-on Machine is already there, it is not tenant-facing, and no model can reach it. `apps/web` calls a narrow provisioner API on it (`create`, `destroy`) behind its own secret. Until that service exists, `npm run machine -- create <app> <org> <image>` is the same operation run by hand.

## 7. What is done and what is next

Done, in this branch:

- Per-account bridge credentials and `acct` scoping, so one bridge can serve several tenants without cross-tenant reads (`apps/whatsapp-bridge/src/server.ts`, `accounts.ts`).
- Per-account `hub_url`, so one bridge can post to several tenant hubs, with the 6PN trap documented where it bites.
- `createComputer` / `destroyComputer` against the Machines API, with the process-group metadata and `autostart` the wake path depends on, and no `env` parameter to put a credential in `config.env` through (`apps/hub/src/host/fly-provision.ts`).

Next, in order, because each one needs the last:

1. **Hand each Bot its account's `bridge_secret`.** `init.ts` strips `WHATSAPP_BRIDGE_SECRET` from every child environment, and rightly: Eve shares uid `box` with the model's `shell`, so the admin credential must never be there. The per-account credential is the thing that comment anticipates. The wrinkle is ordering: the bridge mints missing secrets at its own boot, which happens after init has already planned the Eve children, so either init mints them or the Eves pick one up on the following boot. Pick deliberately.
2. **Per-account restart in the bridge**, so one number's socket dying is not every number's.
3. **The provisioner service on the gateway**, holding the Fly token, with `apps/web` calling it on sign-up.
4. **Tenant rows.** Adding a tenant is still an edit to `computersFromEnv`, which is fine for two and stops being fine when someone signs up on their own. A middle step of a `COMPUTER_CATALOG` environment variable was built and then reverted: it bought a code change nobody had needed to make yet, at the price of a second variable describing tenants beside `COMPUTER_BINDINGS`. Go straight to rows when the trigger fires. The `computer` table already exists as a cache; making it the source turns `computersFromEnv`, `boundComputerId`, `accessibleComputers` and both invite paths async at once, so it should ride alone.
5. **The setup code becomes a stored `issuer`.** `computer.issuerToken` is already a column. A generated-per-tenant setup code sitting in the control plane is the same credential problem in a new place, so provisioning should end by minting an issuer grant and forgetting the code.

The two invariants from `ARCHITECTURE.md` section 8 survive all of it, and are the test for anything proposed here. The hub is still the only door: the gateway reaches a tenant through the connector ingress, which is policy, the audit trail and the wake path, and not around it. And the Machine is still the only isolation boundary: the gateway is a second host, so it is a second boundary, which is exactly why nothing tenant-facing may run on it.

## 8. What this deliberately does not configure

Every setting is a thing to get wrong, document and maintain, so the bar for adding one here is a case where two computers genuinely have to differ. Today none do.

The guest size is fixed at 2 vCPU and 2 GB, because that is what Chromium, Xvfb, Eve and the hub need and also Fly's ceiling for a suspendable Machine, so it is bounded on both sides. The region is `syd`, because both tenants are there and a volume cannot move regions anyway. The volume is one size. `autostop` is `suspend` with no way to ask for anything else, because a tenant that must stay awake is the exact problem this plan removes: once the socket lives on the gateway, no tenant has a reason to.

There is no `env` parameter, which is not a simplification but a guarantee: with no way to pass one, there is no way to put a setup code somewhere the Machines API reads it back.

When one of these genuinely needs to vary, add it then, for that reason. A knob added ahead of its reason is a knob whose correct value nobody knows.
