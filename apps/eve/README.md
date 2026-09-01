# eve

This is an [eve](https://eve.dev) agent bootstrapped with [`eve init`](https://eve.dev/docs/reference/cli#eve-init).

## Getting started

First, run the development server:

```bash
eve dev
```

The development TUI opens an interactive session where you can send messages to your agent.

Start by editing `agent/instructions.md` to define the agent's identity, purpose, tone, and response guidelines. Configure its model and runtime behavior in `agent/agent.ts`.

Add capabilities under `agent/`, including tools, connections, channels, skills, subagents, and schedules. eve reloads your changes as you work.

## On `.grok-plugin` interop

`agent/skills/` is already in `.grok-plugin`'s `skills/*/SKILL.md` shape, so
adding `agent/.grok-plugin/plugin.json` is a one-file change whenever someone
actually wants ecosystem installability.

It is deliberately not there yet. The manifest has to sit in `agent/` — that
discovery resolves `skills/*/SKILL.md` relative to the manifest — and eve's
`createUnsupportedRootDirectoryDiagnostics` warns unconditionally on any
unknown directory in the agent root, with no ignore config. So the manifest
costs a permanent `eve build` warning and nothing consumes it today.

## Learn more

To learn more about eve, explore these resources:

- [eve documentation](https://eve.dev/docs) — learn about eve's features and authoring APIs.
- [Build an Agent tutorial](https://eve.dev/docs/tutorial/first-agent) — build and deploy an agent step by step.
- [eve on GitHub](https://github.com/vercel/eve) — view the source and contribute.

## Deploy on Vercel

Deploy your agent to [Vercel](https://vercel.com) from the project root:

```bash
eve deploy
```

`eve deploy` links a Vercel project if needed and deploys the agent to production. See the [eve deployment documentation](https://eve.dev/docs/guides/deployment/vercel) for authentication, environment variables, and deployment options.
