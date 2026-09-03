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

The secret prints once and is never recoverable. Run it on the Machine, where
`connectors.json` lives beside the roster:

```bash
fly ssh console -a mblode-computer
cd /opt/computer
COMPUTER_DATA=/workspace/.computer/bots.json \
  npm run bot -- connector add whatsapp whatsapp main
#                              ^id      ^kind    ^bot
```

`kind` picks the Eve route: `whatsapp` reaches `/eve/v1/whatsapp/message`, and
that only exists if the Bot re-exports the channel at
`agent/channels/whatsapp.ts`.

## 5. Point the WhatsApp bridge at it

In `vcmc-agent`, on Railway. All three or none: a half-configured bridge falls
back to @vibey rather than posting into a 404.

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

## Rolling back

```bash
fly releases -a mblode-computer          # find the last good version
fly deploy -c fly.toml --image <image>   # from `fly releases --image`
```

The volume is not touched by a deploy, so `/workspace` (the roster, seats,
connector secrets, Bot profiles, memory, Chromium profiles) survives a
rollback. A connector secret minted in step 4 survives too.
