# Evals for the shipped Bot

Ported from `vcmc-agent/evals` on 2026-09-06 (`docs/plans/vibey-on-expert.md`
slice 6). They run with `eve eval`, not vitest, from this directory's project:

```sh
cd apps/eve/bots/main
npm run test:evals                  # the whole suite, ~45 minutes
npx eve eval routing/skills         # one directory while iterating
```

Three things they need that a unit test does not:

- **Gateway credentials.** The judge is a model (`evals.config.ts`), and
  without `AI_GATEWAY_API_KEY` the judge-backed cases fail rather than skip.
- **The tenant's content.** Most cases are about the VCMC community, so point
  `COMPUTER_BOT_DATA` at a directory holding the files `apps/eve/README.md`
  lists (the archive, the roster, the history, `instructions.md` and
  `skills/`). Those files are not in this repository; they are on
  `vcmc-computer`'s volume and are exported from the private `vcmc-agent`
  repo. Without them the routing and recall cases fail on purpose: the tools
  answer `available: false` and the Bot says so.
- **A namespace for the memory fixtures.** `memory/srsr-revert` and
  `safety/memory-injection/*` refuse to run unnamespaced so they cannot land
  in real chat memory: `EVE_EVAL_FIXTURES=1 MEMORY_BLOB_PREFIX=eval npx eve eval memory safety/memory-injection`.

Judge criteria only see the last turn's prompt and reply, never earlier
turns, so a multi-turn case asserts on `requireToolCall(...).input` rather than
on a judge. The suite is the parity gate for cutting the VCMC group over from
the old runtime: every case green on Vercel has to be green here first.

## Running them on the computer

The credentials and the tenant content are already on `vcmc-computer`, so the
suite can run there. Two things bite. **Never run it in the live project
directory**: `.eve/.workflow-data` is a symlink to the production workflow
store and `eve eval` upgrades that store's format marker on open (it did, on
2026-09-06). **Fly suspends the Machine** after about five minutes without
inbound traffic and the run dies with it. And the WhatsApp channel's loopback
auth wants `COMPUTER_EVE_SECRET` at load time; any placeholder satisfies it,
no eval reaches that route. Leave `COMPUTER_URL` unset so the box tools fail
closed rather than driving the real desk from an eval.

```sh
# on the box, as root via fly ssh console: a scratch tree with no .eve
rm -rf /tmp/eve-copy && mkdir -p /tmp/eve-copy/bots
cp -R /opt/computer/apps/eve/lib /tmp/eve-copy/lib
cp -R /opt/computer/apps/eve/bots/main /tmp/eve-copy/bots/main
rm -rf /tmp/eve-copy/bots/main/.eve /tmp/eve-copy/bots/main/.output
ln -s /opt/computer/node_modules /tmp/eve-copy/node_modules
chown -R box:box /tmp/eve-copy
runuser -u box -- sh -c 'cd /tmp/eve-copy/bots/main && HOME=/home/box COMPUTER_EVE_SECRET=eval-only-placeholder \
  COMPUTER_BOT_DATA=/workspace/.bots/main/data EVE_EVAL_FIXTURES=1 MEMORY_BLOB_PREFIX=eval \
  EVE_DOCKER_PATH=/usr/bin/false nohup npx eve eval --strict > /tmp/evals.log 2>&1 &'
# from your laptop, until it finishes: curl -s https://vcmc-computer.fly.dev/healthz every 20s
```
