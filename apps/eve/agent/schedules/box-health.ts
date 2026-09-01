import { defineSchedule } from "eve/schedules";

/**
 * The standing box checks on itself once a day.
 *
 * Markdown (task) mode rather than a `run` handler: a handler exists to hand
 * work to an eve channel, and this agent's voice is not a channel — it is the
 * `send_message` tool over the hub. Task mode lets the model decide whether to
 * call it, which is exactly the behaviour this routine needs.
 *
 * Task mode cannot park for a person, so nothing on this path may ask for
 * approval. `shell` skips its gate for the app principal that schedules run
 * as; see the comment on its `approval`.
 *
 * The cron is evaluated in UTC on Vercel, so this is 20:00 UTC, not 20:00
 * wherever the box is.
 */
export default defineSchedule({
  cron: "0 20 * * *",
  markdown: `A daily check on my own computer. Nobody asked for this, so speak only if
something needs a person.

\`shell\` takes argv and is not a login shell: no globs, no pipes, no builtins.
Every command below is written to work as plain argv.

1. Disk: \`df -P /workspace\`. Note the use percentage.
2. If /workspace is at 80% or more, find what is big: \`du -x -h --max-depth=1 /workspace\`,
   then the same one level into the largest directory.
3. Packages: read \`/workspace/packages.md\` if it exists. For each package it
   lists, check it is still installed with \`dpkg -s <name>\`. A computer update
   rebuilds the OS image and takes every apt-installed package with it — that
   list is how I put them back, so it is only useful if it is accurate.
4. Append one dated line to \`/workspace/health.md\`: the date, the use
   percentage, and either \`ok\` or what was wrong. That file is the history,
   and it is how I notice slow growth instead of only a single bad day.

Then decide whether to speak.

**Send nothing** when the disk is under 80% and every listed package is
present. This is the normal outcome, it is not news, and a "checked, all good"
message every day trains the human to ignore me. A quiet run is a silent run.

**Send one short message** when the disk is at 80% or more, a package from
packages.md is missing, or a step failed. Say what is wrong and the one thing
you suggest doing about it. If the fix is obviously safe and reversible —
clearing a package cache, reinstalling from packages.md — do it first and say
what you did, rather than asking for permission to do the obvious.`,
});
