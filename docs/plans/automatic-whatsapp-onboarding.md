# Automatic WhatsApp onboarding

A first DM to Vibey creates a private phone account, queues the message, and
provisions its own Fly app, volume and computer. No invitation, email or connection
code precedes the first conversation. Existing connected and reserved identities
keep their routes. Groups retain the community agent.

The control plane owns durable provisioning rows and message receipts. A leased
worker advances idempotent Fly steps. The existing clock polls an authenticated
control-plane endpoint to retry unfinished setup and discover tenant wake keys.
Fly and model credentials stay server-side; no customer's Cursor key is copied.
The platform has an explicit capacity ceiling, not unlimited external allocation.

A phone account may later be claimed by a signed-in web account using a short-lived
link sent only to that WhatsApp identity. Claiming refuses an already bound web
account or phone transfer. The same computer and history survive the claim.

Acceptance: duplicate first DMs create one account; provider acknowledgement loss
reconciles the same app/volume/machine; first messages survive worker restarts;
new phone identities never reach Blode or community history; claim tokens expire
and cannot transfer an existing account; clock accepts only registered tenant
keys. Run scoped tests, the repository check, and a real provisioned canary before
enabling automatic signup. Rollback disables new allocation but preserves rows,
volumes, active routes, and queued messages for recovery.

## Implementation and acceptance, 2026-09-05

`phone-account.ts` owns atomic phone/key/capacity reservations, provisioning leases,
queued first messages, and optional web claims. `phone-provision.ts` advances the
Fly app, secret vault, address, volume, machine, health and phone binding steps.
The gateway calls it after persisting ingress; the clock independently resumes
pending work and caches the authenticated tenant registry on its volume.

The live disposable canary `expert-c95e083d73dc433ba99e5805af1a72ba` reached
`ready` with healthy hub/Eve and a persisted owner binding. No message was sent
from the canary. The first canary caught the hub's 32-character account limit;
account IDs now use UUID hex without hyphens, with a regression assertion.

Full `npm run check` passes, including 148 web tests and clock discovery/restart
coverage. Existing Cursor keys are not copied. New accounts reserve distinct
AI Gateway keys atomically from `EXPERT_MODEL_KEYS`; the initial pool has 25 keys,
each with a $5 monthly provider-enforced quota. The Fly org provisioning key
expires after 180 days. The web owns both credentials; the clock owns only its
provisioning-trigger credential and per-tenant wake keys.

The web signup switch is `EXPERT_AUTOMATIC_SIGNUP=on`, bounded by
`EXPERT_SIGNUP_CAPACITY` and the available key pool. Increasing capacity requires
adding dedicated keys, not sharing an existing account's key. Existing accounts
keep their persisted key when the pool changes. Do not remove account rows to
recycle keys or free capacity; account deletion and billing are separate work.

The chat is usable before email signup. Sending `workspace` returns a 15-minute
claim link; a signed-in, verified email account may explicitly claim that same
computer, never an existing account's computer. Plugins requiring login still
use the existing authenticated setup surfaces. Automatic signup does not connect
another person's Cursor subscription or other third-party accounts for them.

Production release: Vercel `dpl_H1KMrK8SfFmpsJ2VkSkwUDkWXUT2` serves
`hello.expert`; clock image `deployment-01M1R2PV10CP89DP6FV20CX6BT` is healthy.
The provisioning endpoint returned 401 without its credential and 200 with it.
The clock refreshed its persisted tenant registry after deployment. The public
signup page returned 200 with the WhatsApp entry link and automatic setup copy.
A Chrome WhatsApp check through the existing owner account received the exact
requested response, `Still connected`, at 16:18 Melbourne time. The disposable
canary and temporary credential files were removed after verification.

Verification limit: the live canary exercised actual computer provisioning and
phone binding without sending a message. A second person's first WhatsApp DM was
not exercised live; reservation, queued delivery and claims have automated test
coverage. The existing owner's WhatsApp path was verified live after deployment.
