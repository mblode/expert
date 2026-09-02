import { defineSchedule } from "eve/schedules";

/**
 * Daily check on this guest. Markdown (task) mode: the model decides
 * whether to speak.
 *
 * Cron is UTC. 20:00 UTC is morning in Australia/Melbourne, which is
 * where this box is meant to live.
 */
export default defineSchedule({
  cron: "0 20 * * *",
  markdown: `A daily check on my own computer (the Fly guest). Nobody asked
for this, so speak only if something needs a person.

\`shell\` takes argv and is not a login shell: no globs, no pipes, no builtins.
Every command below is written to work as plain argv.

1. Disk: \`df -P /workspace\`. Note the use percentage. This volume is the
   only persistent disk, hub roster, bot tokens, and my files all live here.
2. If /workspace is at 80% or more, find what is big: \`du -x -h --max-depth=1 /workspace\`,
   then the same one level into the largest directory.
3. Confirm the computer state dir exists: \`test -d /workspace/.computer\`.
   If it is missing, say so, that is where the roster lives and a missing
   dir means the next boot will mint a new primary token.
4. Packages: read \`/workspace/packages.md\` if it exists. For each package it
   lists, check it is still installed with \`dpkg -s <name>\`. A computer update
   rebuilds the OS image and takes every apt-installed package with it.
5. Append one dated line to \`/workspace/health.md\`: the date, the use
   percentage, and either \`ok\` or what was wrong.

Then decide whether to speak.

**Send nothing** when the disk is under 80%, \`/workspace/.computer\` exists,
and every listed package is present. A quiet run is a silent run.

**Send one short message** when the disk is at 80% or more, \`.computer\` is
missing, a package from packages.md is missing, or a step failed. Say what
is wrong and the one thing you suggest. Do not fix it yourself: a scheduled
run has nobody watching, so anything beyond reading (a reinstall, a cache
clear, a delete) waits for a person to say so.`,
});
