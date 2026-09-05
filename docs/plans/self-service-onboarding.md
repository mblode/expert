# Self-service onboarding

The first-message entry flow is now implemented by
[automatic WhatsApp onboarding](automatic-whatsapp-onboarding.md). This document
records the earlier web-first flow and its account connection decisions.

## Outcome

A person signs in, claims their private computer, connects WhatsApp and completes
one real conversation without an operator editing their account configuration.
One assistant and one isolated computer per account. Existing Blode and Vibey
bindings continue to work.

## Decisions

The user selected one shared Expert WhatsApp number. A customer uses their
existing WhatsApp account, verifies it with a one-time connection code, and
confirms that number in their signed-in workspace. No customer needs another
SIM or a linked-device QR code. The user selected the existing Vibey account as the platform contact. Its group
conversations retain the community route; verified private DMs use the account binding.

Invite-only beta versus paid public signup remains open. Prepared-computer
invitations provide bounded admission while that decision is pending.

The independent first slice is a one-time, email-bound computer invitation. An
operator registers a prepared computer with a setup credential, and the recipient
claims it after verified sign-in. This is capacity admission for a beta, not
automatic Fly provisioning. It uses the existing database, auth and Seat.Pair.
No new service or dependency is needed. It must never invite someone onto an
existing seeded tenant or let two users claim the same computer.

## First slice

Store computer invitations and their eventual user ownership together in one
record. Keep only a hash of the invitation token. Require a verified matching
email, enforce unique computer and user ids in the database, and claim with one
conditional update. Retrying an already claimed invitation by its owner works;
replaying it as another account does not. Store the setup credential server-side,
never in a link or API response. Resolve dynamic computers only through ownership,
never through the existence of a catalog row or a stored session seat alone.

Expose a setup page with sign-in, claim, failure and ready states. Existing
onboarding remains the preference tour, not proof that a computer is ready.
The operator API and page create an invitation without sending it externally.
Authentication, same-origin write checks, input limits and an HTTPS Fly hostname
constraint apply before remote pairing or credential persistence.

## Remaining platform slices

1. Resumable Fly provisioning: persist app identity before external effects,
   configure secrets before boot, reconcile every uncertain create, and enforce
   admission before allocating capacity. No blind repeat of volume creation.
2. WhatsApp connection: implement the selected number model, verify the sender,
   restrict new assistants to their owners, and use an always-on ingress.
3. Dynamic clock enrollment: new computers can register wake leases without
   redeploying the fleet; credentials remain tenant-scoped.
4. First conversation acceptance: show setup complete only after a real inbound
   message and confirmed outbound reply. Show retry/reconnect for interruptions.

## Verification

The first slice tests real SQLite uniqueness and concurrent invitation claims,
wrong email, unverified email, expiry, repeat claims and cross-tenant catalog
selection. Web typecheck and the existing web test suite must pass. Browser
verification covers signed-out setup, invalid invitation and form validation.
Live allocation is not verified by mocked provider calls.

## Review

The prepared-computer invitation slice is deployed. Automatic provisioning
remains unimplemented, so this is an invitation beta rather than open allocation.
Prepared capacity avoids unbounded provisioning costs while the beta is developed.
Rollback disables invitation creation and retains ownership rows and user data.

## Implementation evidence, 2026-09-05

The prepared-computer invitation slice is implemented in
`apps/web/lib/computer-enrollment.ts`, `/api/enrollment`, and `/start`.
Dynamic ownership is resolved by `accountComputers` before session pairing or
template creation. Unbound signups now reach setup instead of a broken workspace.
An unclaimed invitation can be renewed for its original recipient; a claimed
computer cannot be reassigned through invitation creation.

Web typecheck, scoped lint and all 132 web tests passed. Seven enrollment tests
exercise actual SQLite claims, including concurrency, expiry, renewal and tenant
isolation. The production Next build passed. Browser verification confirmed the
signed-out setup page and sign-in return path. The live local API returned 401
without a session and 403 for a foreign-origin write.

No invitation was issued to another person and no new machine was provisioned.
The web slice was deployed to `hello.expert` on 2026-09-05, with operator access
enabled for the existing owner. Full new-customer signup acceptance still needs
a separately prepared computer and its clock registration.

Chrome verification confirmed the existing WhatsApp computer link preserves the
computer, bot and conversation parameters. The remote desktop rendered, taking
the seat showed "You have the seat", and returning it showed "Eve has the seat".
This verifies the existing owner path, not multi-tenant shared-number onboarding.

## Single-number implementation

The shared-number flow is implemented. `/api/whatsapp/connection` creates
an expiring code and confirms a transport-verified phone for the signed-in
account. The gateway endpoint resolves that phone to a hub connector. Pending
phones are reserved and cannot fall back to the community agent. A failed hub
binding remains inactive and retries the same identity. Established hub owners
cannot be replaced by repeating setup.

Vibey's bridge opts in with `EXPERT_PLATFORM_URL=https://hello.expert` and
`EXPERT_GATEWAY_SECRET`. The web deployment receives the same gateway secret and
`EXPERT_WHATSAPP_NUMBER=61494718128`, the existing Vibey number verified from the
connected bridge account. Each prepared computer uses `COMPUTER_SHARED_WHATSAPP=on`, a stable
`COMPUTER_PA_ACCOUNT`, its own delivery credential, the existing bridge URL, and
the durable clock configuration. It needs no phone owner until setup binds one.
The gateway credential belongs only to web and bridge, never to a tenant guest.

Web and bridge support are deployed; the Blode guest release is
`mblode-computer:expert-live-1d8a5db`. Chrome WhatsApp Web sent the generated
connection code through Vibey, the gateway confirmed the phone, and the signed-in
setup page confirmed the existing owner's number. The page now reports WhatsApp
connected, and the guest persisted the same owner in `whatsapp-owner.json`.
The original static Blode route remains a fallback for compatibility. A new
customer still needs prepared capacity and a clock registration; automatic Fly
provisioning remains a separate, incomplete slice.

## Product design brief and audit

Job: connect an existing WhatsApp account to a private assistant without a SIM,
QR pairing, bot selection or a settings tour. Success is a verified phone binding
followed by a real inbound message and reply. Connecting grants that phone access
to this account's assistant. A customer can replace an unconfirmed candidate;
an established connection currently needs operator recovery to change numbers.
The UI does not promise an undo or self-service transfer that does not exist.

- `rule/one-primary-action`: WhatsApp setup owns the primary action; opening the
  workspace is a navigation link and operator invitations are disclosed inline.
- `rule/name-object-scope-consequence`: show the detected phone and the access it
  receives before connecting it. The phone is not inferred from typed form data.
- `rule/time-limit-adjustable`: code expiry preserves the workspace and offers a
  new code. A pending candidate can be replaced before remote binding starts.
- `rule/cover-reachable-states`: loading, unavailable, awaiting message, detected
  phone, interrupted binding, active, expired and failed checks have distinct UI.
- UI audit fixes: `states-no-error-state` adds an inline retry; loading no longer
  flashes unavailable. `async-out-of-order-responses` serialises polling and
  aborts a stale check on mutation. `focus-on-dynamic-content` announces status
  changes through a live region. Existing form fields survive failed submission,
  and pending controls use the shared Button's loading state.

Rejected findings: there is no nested modal; native details preserves inline
context. Invitations reset fields only after success, not after errors. Primary
buttons use the shared loading control rather than swapping their labels.

Verification status: backend, type and runtime checks pass. The new authenticated
setup states and compact viewport remain unverified in Chrome because browser
navigation was interrupted. No visual ship verdict is claimed for those states.

Skills loaded: product-design shape mode, `references/rules.md`,
`references/product-judgment.md`, `references/surfaces.md`; ui-design Audit mode,
`references/feature-playbooks.md`, `rules/_sections.md`, `states-no-error-state`,
`states-no-empty-state`, `forms-lost-data-on-error`,
`forms-no-disable-while-submitting`, `focus-on-dynamic-content`, and
`async-out-of-order-responses`. No Build guidance or new visual system was used.

### UI audit completion status

The machine-readable report is `self-service-onboarding.ui-audit.json`.
Six findings were fixed, with no confirmed finding left in that scope. The
verdict is **INCOMPLETE**, because authenticated desktop and mobile rendering,
keyboard traversal, console and network checks still need a stable Chrome session.
Chrome returned `Debugger unattached`; native navigation reached the setup page
title but the next screenshot showed an unrelated sign-in window. That is not
evidence of a successful setup-page check.

The final pass bounded claim and invitation requests, removed raw network-error
text, preserved loading button names, expanded touch controls and removed nested
labels around the shared Input component. The production Next.js build passed
after these edits, and all 137 web tests and scoped lint passed. The local
production preview runs at `http://localhost:3099/start` with an isolated in-memory
database and a temporary local signing key. Its signed-out setup returns HTTP 200
with the expected viewport metadata. This is not an authenticated enrollment test.
These changes are still local; shared-number cutover is not complete.

Additional Audit references loaded: `references/ship-readiness.md`,
`references/output-adapters.md`, and rules `forms-labels-and-autocomplete`,
`forms-mobile-input-font-size`, `mobile-viewport-scaling`,
`mobile-hover-only-affordance`, `a11y-semantic-html-first`,
`microcopy-leaked-error-message`, `interaction-target-size`,
`states-layout-shift`, `interaction-keyboard-operable`, and
`interaction-focus-visible`.
