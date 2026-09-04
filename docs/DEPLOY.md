# Getting it live

What to run, in what order, and how to tell each step worked. Written from a
real deploy on 2026-09-03; every check below is one that was run.

Three surfaces, deployed separately and in this order. The web app is safe to
ship first because it degrades against an older hub on purpose; the hub is what
switches new features on.

| Surface        | Where      | Deployed by                   |
| -------------- | ---------- | ----------------------------- |
| Control plane  | Vercel     | `git push origin main`        |
| Blode computer | Fly, `syd` | `fly deploy -c fly.toml`      |
| Vibey computer | Fly, `syd` | `fly deploy -c fly.vcmc.toml` |

## 0. Before anything: build the guest image

CI never builds it. It runs `hadolint` over `deploy/fly/Dockerfile` and builds
the _desk_ image, so a guest image that cannot build is not caught until a
Machine is already restarting.

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
git push origin main   # Vercel project `expert-computer` deploys on push
```

`npm run check` runs `proto:check`, which diffs `packages/proto/gen` against
`HEAD`. A regenerated `gen/` is stale by definition until it is committed, so
after any proto change the check only passes on the commit, not before it.

Confirm:

```bash
gh run list --limit 1                       # CI green on your SHA
vercel ls expert-computer --yes | sed -n 4,6p
vercel inspect <deployment-url> | grep -A4 Aliases   # must list hello.expert
```

There are two Vercel projects with the `hello.expert` domain attached,
`expert-computer` (serves it) and `expert-web` (preview deployments only).
Check the alias landed on the deployment you just made.

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
free screen, and the supervisor starts an Eve per Bot. Nothing is minted over
an existing row, so this is safe to run against a volume that already has a
roster. Confirm the roster and the children after the wake:

```bash
# Every shipped Bot has a screen and a profile. Owner seat token required.
curl -s https://mblode-computer.fly.dev/roster -H "authorization: Bearer $SEAT" \
  | node -e 'const b=JSON.parse(require("fs").readFileSync(0)).bots; console.table(b.map(x=>({id:x.id,display:x.display,name:x.profile.name})))'

# One `eve-<id>` child per Bot, each `up`.
curl -s https://mblode-computer.fly.dev/healthz
```

**Size the guest first.** Every screen is an Xvfb, an openbox, an x11vnc and
a Chromium, and every Bot is also a node process, so a roster of eight needs
several gigabytes where one Bot needed 2. Fly's ceiling for a _suspendable_
Machine is 2 GB, so a full roster means editing `[[vm]]` upward and giving up
suspend-to-zero (`auto_stop_machines = "stop"`, a cold start on the next
request), or shipping fewer Bots. A Machine that OOMs mid-boot restarts, and
`/healthz` will show Eves flapping between `starting` and `backoff`.

## 3. The Vibey computer

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

## 4. Provision a connector (only for an inbound channel)

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

## 5. Point the WhatsApp bridge at it

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

## 6. Let a Bot hand out desk links

Without this a Bot in a chat answers "open hello.expert and sign in": it holds
no mint secret, so `expert_invite` degrades rather than minting. One shared
string, set on both ends, turns that into a link that opens the screen on the
member's phone (`apps/eve/lib/tools/expert_invite.ts`, `POST /api/invite`).

```bash
# The control plane. Either name works; the same value goes on the computer.
vercel env add EXPERT_INVITE_SECRET production   # a fresh random string
# Which computer that secret may mint for. Unset means `vibey`, so set it
# explicitly on any deployment where that is not the answer.
vercel env add INVITE_MINT_COMPUTER_ID production

# The computer whose Bot hands the link out. `EXPERT_ORIGIN` only needs
# setting if the control plane is not https://hello.expert.
fly secrets set EXPERT_INVITE_SECRET=… -a vcmc-computer
```

The secret is not in the hub's `DENY` list, so it reaches the Eve child like
any other env, and Eve shares a uid with the model's `shell`: treat it as
something the Bot holds, which is the point. What it buys is a desk link on
one computer, rate-capped at eight in ten minutes per computer
(`MINT_WINDOW_MAX`), and nothing else. Redeeming one is still a guest seat
bound to screen 1 that expires with the link.

Confirm, from anywhere:

```bash
curl -s -X POST https://hello.expert/api/invite \
  -H 'content-type: application/json' -H "x-invite-secret: $SECRET" \
  -d '{"kind":"desk"}'
# {"computerId":"vibey","purpose":"desk","url":"https://hello.expert/desk/…"}
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
