import { defineSchedule } from "eve/schedules";

/** Same guest check as main — only runs if this Bot's Eve process is up. */
export default defineSchedule({
  cron: "0 21 * * *",
  markdown: `A quiet daily check on my own computer. Speak only if something
needs a person.

1. Disk: \`df -P /workspace\`.
2. If use is 80% or more, \`du -x -h --max-depth=1 /workspace\`.
3. Confirm \`/workspace/.computer\` exists.
4. Append one dated line to \`/workspace/health-night.md\`.

Send nothing when the disk is under 80% and \`.computer\` exists.`,
});
