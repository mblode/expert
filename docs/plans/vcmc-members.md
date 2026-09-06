# Members of a shared computer

Plan date: 2026-09-07. Follows [`vibey-on-expert.md`](vibey-on-expert.md), whose
slice 6 leaves the group on the old runtime. It records the decisions Matt made
on 2026-09-07 about who may reach `vcmc-computer` and what they get, and the
sign-in defect found while answering the first of them.

The brief, in Matt's words: sign in is not working; the vcmc computer should be
accessible to all members of vcmc; a computer should have many members, and many
members have many bots, still just one bot type.

## 1. Sign in

**Symptom.** Matt messaged Vibey `sign in` twice on the morning of 2026-09-07 and
got conversational replies from the model ("Sign in where, mate") instead of a
six-digit code. [`whatsapp-sign-in.md`](whatsapp-sign-in.md) says the gateway
answers the command before model ingress, and it does; nothing reached the
gateway.

**Two stacked causes**, both confirmed against the Railway logs, where the
21:43 UTC line reads `forwarding to agent ... target="expert"`. The `platformJid`
branch in `sendAgentReply` returns before that log line, so the control plane was
never consulted and the DM went straight to `vcmc-computer`'s connector.

1. `EXPERT_PLATFORM_URL` and `EXPERT_GATEWAY_SECRET` are unset on the Railway
   bridge. Nothing in the deployed bridge repo documented them, and
   `scripts/vibey-cutover.sh route` only ever set `EXPERT_URL` and the connector
   pair. With them unset the platform client is never constructed, so `sign in`
   cannot reach the gateway however it is typed.
2. Even set, `dispatch` called the gateway only after `resolve()` said the sender
   was **bound**. Someone whose DMs are routed to a computer is not bound in the
   gateway's sense, so `sign in` was structurally unreachable for exactly the
   people who have a computer.

Cause 2 is fixed in `vcmc-agent` (`bridge/platform.ts`, commit `452b4b8`): the
command is matched before the resolve gate, with the same regex the gateway uses,
and the reply is the control plane's own wording. Cause 1 is two environment
variables on Railway plus the matching secret on the web deployment; the session
that found it could not write them.

## 2. Decisions taken on 2026-09-07

### Members get guest links, not accounts

A VCMC member asks Vibey for a link and gets a scoped seat that expires. No
durable hello.expert account, no email, no password. WhatsApp is the identity.

This avoids the problem `computer-seat.ts` documents: every signed-in user pairs
as an **owner**, because `/roster`, the pixel stream and `/eve/v1` are owner-only
routes. Giving 122 people accounts on one computer under today's model would give
122 people ownership of it. The hub already has the narrower shape (`Seat.Issue`
from a stored issuer, `operator` / `viewer` / `guest` roles, `SEAT_GUEST_METHODS`,
`MUST_EXPIRE`), and the invite path already uses it.

### Membership is the WhatsApp group

The bridge's live roster is the truth about who is a member. There is no members
table on hello.expert and none is added: the `expert` repo is public, and no VCMC
member data may land in it. Joining the group is joining the computer; leaving is
leaving.

### Many bots per member, one bot type

A member may make several Bots. All of them are instances of the single `main`
template, differing by profile and by the data under `/workspace/.bots/<id>/`,
which is what `Seat.CreateBot` plus `apps/eve/bots/template` already do.

## 3. What has changed so far

- **Sign in reaches the control plane** (`vcmc-agent` `452b4b8`, local only).
- **The mint cap is per sender, not only per computer** (`apps/web/lib/invite-store.ts`).
  One cap of eight links per ten minutes was written for one conversation. With
  every member able to ask, eight members asking would refuse the ninth and tell
  them nothing. The runaway the cap exists to stop, a model in a loop, is one
  sender by definition, so the tight bound is three per sender and the computer's
  ceiling is forty.

## 4. Open

1. **Two Railway variables and one Vercel secret.** `EXPERT_PLATFORM_URL` and a
   shared `EXPERT_GATEWAY_SECRET`. Until they are set, section 1 is only half
   fixed. Push `452b4b8` first, or the deploy carries the old dispatch.
2. **Invites from the group carry no sender.** `vcmc-agent/agent/lib/expert-invite.ts`
   posts `{ kind }` and nothing else, so the per-sender cap cannot bind an invite
   minted from the group today. The ported `apps/eve/lib/tools/expert_invite.ts`
   already passes `chat?.jid`. The clean route is the group cutover, which is
   slice 6 and a live-traffic decision.
3. **Minting is gated by the model's judgement, not by membership.** A link should
   be mintable only for a sender the bridge's roster still lists. That is a
   membership check on the mint path, reading the roster the bridge already
   serves at `/members`.
4. **Bots per member.** Attribution of a Bot to a WhatsApp identity, a
   member-scoped `CreateBot` from chat, and routing that member's DMs and mentions
   to their own Bot. Nothing built.
