# Getting it live

What to run, in what order, and how to tell each step worked. Written from a
real deploy on 2026-09-03; every check below is one that was run.

Four surfaces, deployed separately and in this order. The web app is safe to
ship first because it degrades against an older hub on purpose; the hub is what
switches new features on. The clock goes after the computers, because it wakes
them for routines they have to be carrying already.

| Surface        | Where      | Deployed by                    |
| -------------- | ---------- | ------------------------------ |
| Control plane  | Vercel     | `git push origin main`         |
| Blode computer | Fly, `syd` | `fly deploy -c fly.toml`       |
| Vibey computer | Fly, `syd` | `fly deploy -c fly.vcmc.toml`  |
| The clock      | Fly, `syd` | `fly deploy -c fly.clock.toml` |

## 0. Before anything: build the guest image

CI never builds it. It runs `hadolint` over `deploy/fly/Dockerfile` and
`deploy/clock/Dockerfile` and builds the _desk_ image, so a guest image that
cannot build is not caught until a Machine is already restarting.

```bash
docker build -f deploy/fly/Dockerfile -t expert-guest-verify . && \
  docker rmi expert-guest-verify
```

`fly deploy` builds from the working tree, not a clean checkout, so this build
sees exactly what the deploy will. The failure it catches most often is a local
`.output` from running `eve build`: the image runs its own `eve build`, which
renames any existing `.output` to a backup, and that rename is `EXDEV` across
the overlay. `.dockerignore` excludes `**/.output` for this reason. The nitro
build succeeds first, so the error reads as unrelated to whatever you changed.

## 1. The web app (hello.expert)

```bash
npm run check          # typecheck x7, layer lint, ultracite, knip, tests, proto
git push origin main   # Vercel project `expert` in team `blode` deploys on push
```

`npm run check` runs `proto:check`, which diffs `packages/proto/gen` against
`HEAD`. A regenerated `gen/` is stale by definition until it is committed, so
after any proto change the check only passes on the commit, not before it.

Confirm:

```bash
gh run list --limit 1                       # CI green on your SHA
vercel ls expert --scope blode | sed -n 4,6p
vercel inspect <deployment-url> | grep -A4 Aliases   # must list hello.expert
```

As verified on 2026-09-05, `blode/expert` serves `hello.expert`. Earlier notes
named `expert-computer`; that project name no longer resolves. Check the
production alias landed on the deployment you just made.

## 2. The Blode computer

```bash
fly deploy -c fly.toml -a mblode-computer --wait-timeout 900
```

`fly deploy` without `-c` targets `mblode-computer`. Never rely on that when
you mean Vibey.

Both Machines suspend when idle, so the first request after a deploy wakes one
and takes ~20s. Expect empty replies until it is up; that is the wake, not a
failure.

Confirm the new hub is actually serving, rather than that the deploy exited 0:

```bash
# Supervisor view, not a bare {"ok":true}. The old build answered `ok`
# unconditionally, so the shape is the version tell.
curl -s https://mblode-computer.fly.dev/healthz

# The connector ingress exists. `bad connector secret` is the pass:
# `{"code":"VALIDATION","message":"not found"}` is the 404 fallthrough and
# means the ingress is not in this build.
curl -s -X POST https://mblode-computer.fly.dev/connectors/whatsapp/message \
  -H 'content-type: application/json' -H 'x-connector-secret: probe' \
  -d '{"token":"x","message":"x"}'

# A new RPC is deployed. `missing bearer` is the pass; compare against a
# name that does not exist, which answers `not found`.
curl -s -X POST https://mblode-computer.fly.dev/computer.v1.Seat/SetBotProfile \
  -H 'content-type: application/json' -d '{}'
curl -s -X POST https://mblode-computer.fly.dev/computer.v1.Seat/NotARealRpc \
  -H 'content-type: application/json' -d '{}'

fly status -a mblode-computer   # checks: 1 passing, not 1 warning
```

`/healthz` stays HTTP 200 while the hub answers even when a child is down, so
Fly does not restart the Machine over a crash-looping Eve. Read the JSON, not
the status code: `ok:false` with `eve-main` in `starting` right after a deploy
is normal, and `state: "up"` is what you are waiting for.

### A deploy that adds Bots

A build that ships new projects under `apps/eve/bots` provisions them on the
next boot: init mints a roster row and a token for each one, on the lowest
free screen, and the supervisor registers an Eve per Bot. Nothing is minted
over an existing row, so this is safe to run against a volume that already has
a roster. Confirm the roster and the children after the wake:

```bash
# Every shipped Bot has a screen and a profile. Owner seat token required.
curl -s https://mblode-computer.fly.dev/roster -H "authorization: Bearer $SEAT" \
  | node -e 'const b=JSON.parse(require("fs").readFileSync(0)).bots; console.table(b.map(x=>({id:x.id,display:x.display,name:x.profile.name})))'

# One `eve-<id>` child per Bot: `eve-main` up, the rest stopped until used.
curl -s https://mblode-computer.fly.dev/healthz
```

**The guest stays at 2 GB.** A roster of Bots does not fit awake: a Bot's Eve is
224 MB and a claimed screen (Xvfb, openbox, x11vnc, Chromium) is about 430,
so they sleep instead. Only the primary Bot runs at boot; every other Bot's
Eve is registered and stopped, and its window is claimed the first time
something touches that screen and released after 30 minutes idle. Messaging
a Bot wakes it in about a second, and a routine wakes its Bot a minute early
(`agent/routines.json`, read by the hub).

What that means when you read `/healthz` after a deploy: `eve-main` should be
`up`, and every other `eve-<bot>` `stopped` until you talk to it. A stopped
lazy child is not a fault and does not make `ok` false. To see one wake, open
its chat and watch the child move to `starting` then `up`:

```bash
# The wake markers the hub writes, one per awake Bot.
fly ssh console -a mblode-computer -C "sh -lc 'ls -l /run/computer/wake'"

# What is actually running, and how much of the Machine is left.
fly ssh console -a mblode-computer -C "sh -lc 'ps -eo rss,args --sort=-rss | head -15; free -m'"
```

If a Bot never wakes, the marker is the place to look: no file means the hub
never asked (check `COMPUTER_WAKE_DIR` reached the hub child), a file with a
past timestamp means it was asked and the window has since closed. Two Bots
may be awake and two screens up at once; a third request puts the one used
longest ago back to sleep, which the guest log says out loud.

**Routines need the clock deployed too** (next section). Nothing inside a
suspended guest has a clock, so the guest alone runs a routine only on a day
somebody happened to be using the computer.

## 3. The clock

`apps/clock` is a separate always-on Fly app, one for the whole fleet, whose
only job is to wake a suspended computer before its routines are due. It reads
the Bots' `agent/routines.json` out of its own image, so **a routine added,
moved or removed is two deploys**: the guest, and this. Deploying the guest
alone ships a routine the clock will never wake anything for, which fails
silently, which is the whole reason this app exists.

```bash
fly deploy -c fly.clock.toml --wait-timeout 600
```

Verify it knows what the guest knows. There is no public port, so read it from
inside:

```bash
# The schedule it is running, and the next firings it is waiting for.
fly ssh console -a expert-clock -C "sh -lc 'curl -s localhost:8080/healthz'"

# Which is the same list the guest has.
fly ssh console -a mblode-computer \
  -C "sh -lc 'cat /opt/computer/apps/eve/bots/*/agent/routines.json'"
```

`ok: false` there means it has no schedule or no targets, and the Machine
check will be failing: check `CLOCK_TARGETS` in `fly.clock.toml` names each
computer's **public** hostname (`https://<app>.fly.dev`, never
`<app>.internal`, which skips Fly Proxy and so never wakes anything).

Watch one wake happen. Pick a routine's UTC minute from that output and:

```bash
fly logs -a expert-clock          # "waking for <bot>/<routine> at ..."
fly logs -a mblode-computer       # "routine <id> is due: waking <bot>"
```

Adding a computer to the fleet means adding it to `CLOCK_TARGETS` and
redeploying the clock; nothing else on either side changes. Vibey is
deliberately not a target: its Eve is an overlay on that Machine's volume, so
its routines are not in this repo and not in the clock's image, and waking it
on Blode's schedule would wake it at the wrong minutes and still miss its own.

One Machine runs the clock, so it is a single point of failure for every
routine on every computer, and a routine whose minute passes while it is down
is missed rather than caught up. The PA wake registry now has one volume and
one writer; do not scale it to two independent registries.

## 4. The Vibey computer

Same image, different app and volume.

```bash
fly deploy -c fly.vcmc.toml -a vcmc-computer --wait-timeout 900
```

Vibey's Eve is not `apps/eve/bots/main`. It lives on that Machine's volume at
`/workspace/eve/bots`, and the guest prefers that overlay when it looks like an
Eve project, so a deploy of this repo does not replace it. Check it survived:

```bash
fly ssh console -a vcmc-computer -C "sh -lc 'ls /workspace/eve/bots/main/agent/channels'"
```

If that Machine holds a linked WhatsApp number, a deploy drops the socket for
the restart. It suspends when idle, so check whether one is even running before
worrying about it.

## 5. Provision a connector (only for an inbound channel)

A connector is the third door: `POST /connectors/<id>/<path>` with
`x-connector-secret`, forwarded to that Bot's Eve at `/eve/v1/<kind>/<path>`.
It is how anything that is not a seat reaches a Bot, because Eve is loopback on
the Machine and deliberately not public.

`npm run bot -- connector add` is the local command and does **not** work on a
Machine: `scripts/` is not in the guest image, and `loadEnv()` reads a `.env`
file rather than the environment, so `COMPUTER_DATA=...` in front of it changes
nothing. Write the record instead. It is the same shape the CLI writes, and the
secret is `randomBytes(32).toString("base64url")`:

```bash
fly ssh console -a mblode-computer -C 'node -e "
const fs=require(\"node:fs\"), {randomBytes}=require(\"node:crypto\");
const p=\"/workspace/.computer/connectors.json\";
const cur=fs.existsSync(p)?JSON.parse(fs.readFileSync(p,\"utf-8\")):[];
if(cur.some(r=>r.id===\"whatsapp\")){console.log(\"exists, rotate instead\");process.exit(0)}
const rec={bot:\"main\",created_at:new Date().toISOString(),id:\"whatsapp\",
  kind:\"whatsapp\",paths:[\"/eve/v1/whatsapp/message\"],
  secret:randomBytes(32).toString(\"base64url\")};
fs.writeFileSync(p,JSON.stringify([...cur,rec],null,2)+\"\n\",{mode:0o600});
fs.chownSync(p,1001,1001);
console.log(\"SECRET=\"+rec.secret);
"'
```

uid 1001 is `hub`, which owns `/workspace/.computer` at 0700; the model's
`shell` runs as `box` and must never read it. Prove the door opens before
touching any config, because a wrong secret here looks identical to a bridge
misconfiguration later:

```bash
curl -s -X POST https://mblode-computer.fly.dev/connectors/whatsapp/message \
  -H 'content-type: application/json' -H "x-connector-secret: $SECRET" \
  -d '{"token":"…@s.whatsapp.net","message":"Reply with the word connected.","surface":"dm"}'
# {"reply":"connected"}
```

`kind` picks the Eve route: `whatsapp` reaches `/eve/v1/whatsapp/message`, and
that only exists if the Bot re-exports the channel at
`agent/channels/whatsapp.ts`.

## 6. Point the WhatsApp bridge at it

In `vcmc-agent`, on Railway. All three or none: a half-configured bridge falls
back to @vibey rather than posting into a 404.

`railway variables --set A --set B --set-from-stdin C` silently applies only
the stdin one. Set the plain values in one call and the secret in its own:

```bash
railway variables --set "EXPERT_URL=…" --set "EXPERT_CONNECTOR_ID=whatsapp" \
  --set "EXPERT_DM_JIDS=+61…"
railway variables --set-from-stdin EXPERT_CONNECTOR_SECRET <<< "$SECRET"
railway variables | grep EXPERT   # confirm all four
```

Production `EVE_URL` is `https://vcmc-agent.vercel.app`, not the value in
`.env.example`: @vibey runs on Vercel behind this bridge. Leave it alone. The
Expert route is additive and touches nothing @vibey uses.

| Variable                  | Value                                            |
| ------------------------- | ------------------------------------------------ |
| `EXPERT_URL`              | `https://mblode-computer.fly.dev` (hub, not Eve) |
| `EXPERT_CONNECTOR_SECRET` | printed by step 4                                |
| `EXPERT_CONNECTOR_ID`     | `whatsapp`                                       |
| `EXPERT_DM_JIDS`          | `+61456455551`                                   |

Blode's computer, not Vibey's. @vibey's own Eve already runs on
`vcmc-computer` and the bridge's `EVE_URL` points there, so sending the owner
to that machine routes their DMs to the group agent. This route replaces the
retired personal second-brain agent, and the owner's personal Bot is `main` on
their own Machine.

Confirm from the bridge logs: every forwarded message logs a `target`, `vcmc`
or `expert`.

## 7. Let a Bot hand out desk links

Without this a Bot in a chat answers "open hello.expert and sign in": it holds
no mint secret, so `expert_invite` degrades rather than minting. One shared
string, set on both ends, turns that into a link that opens the screen on the
member's phone (`apps/eve/lib/tools/expert_invite.ts`, `POST /api/invite`).

```bash
# The control plane. Either name works; the same value goes on the computer.
vercel env add EXPERT_INVITE_SECRET production   # a fresh random string
# Which computer that secret may mint for. Unset means `vibey`, and the Bot
# that hands links out is `main` on Blode, so unset is the wrong answer here:
# a mint would return a link to the other tenant's computer rather than fail.
vercel env add INVITE_MINT_COMPUTER_ID production   # blode

# The computer whose Bot hands the link out. `main` on Blode is the only Bot
# in the image with both `expert_invite` and a `whatsapp` channel, so it is
# the one that needs the secret. `EXPERT_ORIGIN` only needs setting if the
# control plane is not https://hello.expert.
fly secrets set EXPERT_INVITE_SECRET=… -a mblode-computer
```

The secret is not in the hub's `DENY` list, so it reaches the Eve child like
any other env, and Eve shares a uid with the model's `shell`: treat it as
something the Bot holds, which is the point. What it buys is a desk link on
one computer, rate-capped at eight in ten minutes per computer
(`MINT_WINDOW_MAX`), and nothing else. Redeeming one is still a guest seat
bound to screen 1 that expires with the link.

### Coding sessions (optional)

Off until a key is set, and the two Seat RPCs answer `DAEMON_DOWN` without
one, exactly as the WhatsApp RPCs do without a bridge.

```bash
fly secrets set CURSOR_API_KEY=… -a mblode-computer
```

Unlike `EXPERT_INVITE_SECRET` above, this one must **not** reach a child the
model can read. It is the hub's own credential and it can write to every
repository the token can see; the hub calls the runner itself and the key is
never in an error message. If it is ever handed to an Eve child, it is a key
the box's own agent can lift out of `/proc`, which is the reason coding
sessions run off the box in the first place (`docs/plans/coding-sessions.md`).

Confirm, from anywhere:

```bash
curl -s -X POST https://hello.expert/api/invite \
  -H 'content-type: application/json' -H "x-invite-secret: $SECRET" \
  -d '{"kind":"desk"}'
# {"computerId":"blode","purpose":"desk","url":"https://hello.expert/desk/…"}
```

Open that URL on a phone: it should show the screen with a bottom bar (the
clipboard, take over or I'm done, the keyboard) and a ⋯ menu holding trackpad
mode. A tap clicks where you tapped, two fingers scroll, a pinch magnifies.

## Rolling back

```bash
fly releases -a mblode-computer          # find the last good version
fly deploy -c fly.toml --image <image>   # from `fly releases --image`
```

The volume is not touched by a deploy, so `/workspace` (the roster, seats,
connector secrets, Bot profiles, memory, Chromium profiles) survives a
rollback. A connector secret minted in step 4 survives too.

## WhatsApp PA pilot, opt-in

The PA path is off until the operator supplies both `COMPUTER_PA_ACCOUNT` and
`COMPUTER_PA_OWNER_JID` on the tenant. Use the exact dedicated account id and
owner JID read from the bridge, not a number suffix or group participant list.
Its connector must be `whatsapp-<account>` and point to the intended Bot. The
bridge's proactive recipient allowlist must include that exact owner destination.
No public or group-wide owner grant is inferred from these settings.

Prepare the clock before enabling the tenant:

1. Create one `clock_data` volume in the clock's region and attach it at `/data`
   using `fly.clock.toml`. Keep one clock writer.
2. Set `CLOCK_REGISTRATION_SECRETS` as a Fly secret containing a JSON map from
   configured tenant name to a distinct random secret of at least 32 characters.
   Never put the secret in a command committed to the repository or in a model
   child's environment.
3. Deploy the clock and verify `/healthz`. Register a test wake through the private
   network, restart the clock Machine, and verify the registration still wakes
   the configured public tenant hostname. Cancel that test registration.
4. On the tenant, set `COMPUTER_CLOCK_URL` to the clock's private HTTP endpoint
   (normally `http://expert-clock.internal:8080`), `COMPUTER_CLOCK_TENANT` to its
   configured target name, and `COMPUTER_CLOCK_SECRET` to the matching secret.
   The clock is always on. Its tenant targets must remain public Fly hostnames
   because those requests need Fly Proxy to wake suspended Machines.
5. Set `COMPUTER_PUBLIC_URL` to the tenant Fly origin, such as
   `https://mblode-computer.fly.dev`, and `COMPUTER_WEB_URL` to
   `https://hello.expert`. The public computer URL serves pixels and identifies
   the tenant in work links; setting it to the web app breaks both. Set the PA
   account and owner JID, and
   `COMPUTER_PA_REPOS` to an explicit comma-separated list of GitHub repository
   URLs. `CURSOR_API_KEY` stays a tenant secret. No key means coding is unavailable.
6. Back up hub-owned state before deploying the guest. An existing real
   `.eve/workflow-state` directory must be migrated with the runtime stopped;
   startup refuses to discard it or silently use ephemeral state.

Hub state now includes `turns.json`, `inbound.json`, `assistant-revisions.json`
and `coding-intents.json` under the existing hub-owned data directory. Bridge
send receipts live under each account's `deliveries/` directory. Preserve them
on rollback. Do not route accepted PA messages through the old synchronous
sender or delete uncertain receipts to force a retry.

The clock supports both short execution leases and persistent due checks.
A due check remains registered across outages until explicitly advanced or
cancelled. Coding checks back off from one minute to fifteen minutes on errors.
Successful result delivery is persisted before its wake is cancelled.
Configuration revisions activate instructions, memories and bounded procedures
at the next turn. User-created routine registration and dynamic plugin activation
are not enabled by this deployment procedure yet.

Local acceptance: `npm run check` includes a built Eve fixture using a deterministic
model, the production WhatsApp channel and the production runtime instruction
reader. It verifies account isolation, current-turn replies, instruction updates
and continuation after restarting Eve. This does not substitute for a real phone,
a Cursor account, a suspended Fly Machine or the seven-day pilot.

### Live Cursor acceptance, 2026-09-05

The Blode account has its own Cursor Cloud Agents key in Fly secrets. No Cursor
key was added to the Vibey computer. The allowed repositories are
`mblode/expert`, `donebear/donebear`, `mblode/captain`, and `mblode/vcmc-agent`.
The key expires on 2027-03-04; rotate it on Blode before that date.

A real Chrome WhatsApp Web message to the existing Vibey contact launched
Cursor agent `bc-f1c5ed46-f096-4b4e-9753-a46f143278ee`. The authenticated Expert
coding breakout rendered its running state and provider link. Cursor finished
the read-only package inspection, reporting Node `24.x` and hub `vitest run`.
The completion notification returned to the same WhatsApp conversation without
an open browser polling the coding page. No PR was created.

Web production is `dpl_UZTUkiaKnTFQjWfGVTYCc3KESqQw` on `hello.expert`. The
shared bridge release is Railway `39684374-b386-42c5-b6b7-497da2190639`, from
VCMC commit `217d64e`; its health endpoint confirmed WhatsApp `open`. The clock
is `expert-clock:deployment-01M1QY78HXTGFJENEEH8508B67`. Full `npm run check`
passed for Expert commit `1d8a5db` before deployment. These observations verify
one owner's live path, not automatic computer provisioning for new customers.

The final Blode guest is `mblode-computer:expert-live-1d8a5db`, image digest
`sha256:45aed38cf26619bd798fdad2904cc4d3d46268fd4f3dfef814c5f146fb8d75ad`.
Its public health endpoint reports a healthy hub and main Eve child. Chrome
completed code generation, WhatsApp transport verification, and signed-in phone
confirmation on `/start`; the existing owner's binding is active and persisted.
The final DM through that binding returned the exact requested phrase,
`Expert connected`, in the real WhatsApp chat.
New customers still require prepared capacity, their own Cursor key, and a clock
registration. Invitation creation does not provision any of those automatically.

### Automatic WhatsApp signup

New DMs can allocate private computers without invitations. See
`docs/plans/automatic-whatsapp-onboarding.md` for the tested flow and limits.
The web needs `EXPERT_FLY_TOKEN`, `EXPERT_FLY_ORG`, `EXPERT_COMPUTER_IMAGE`,
`EXPERT_MODEL_KEYS` (JSON array of distinct, budgeted Gateway keys),
`EXPERT_SIGNUP_CAPACITY`, and `EXPERT_AUTOMATIC_SIGNUP=on`.
The web and outer clock share `EXPERT_PROVISION_SECRET`; the clock additionally
uses `EXPERT_PLATFORM_URL=https://hello.expert`. It retries unfinished provisioning
and discovers tenant wake registrations without a per-tenant deployment.

Disable `EXPERT_AUTOMATIC_SIGNUP` to stop new allocation. Existing private routes,
queued messages and provisioning rows remain, so already accepted work can finish.
Preserve the phone tables and `/data/platform-targets.json` during recovery.
Never deploy a Fly administration key or another customer's Cursor key into a
new guest. The guest image remains pinned to the verified digest above.
