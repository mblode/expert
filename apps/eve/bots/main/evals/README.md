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
