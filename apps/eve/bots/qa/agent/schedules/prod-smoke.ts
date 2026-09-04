import { defineSchedule } from "eve/schedules";

/**
 * The production smoke test: the main path of every product, in a real
 * browser, on this Bot's own screen. Twice a day, because the failure this
 * catches (a deploy that broke the signed-out path) is the one nobody
 * notices until a customer says so.
 *
 * Cron is UTC. 02:00 and 14:00 UTC are midday and midnight in Melbourne,
 * which keeps it away from the morning health check.
 */
export default defineSchedule({
  cron: "0 2,14 * * *",
  markdown: `Smoke test production. Nobody asked for this, so speak only if
something needs a person.

Read \`skills/screen\` and \`skills/browser-qa\` first. For each product in
\`/workspace/products.md\`, in the browser on my screen:

1. Load the public URL. Screenshot. Does the page render, or is it an
   error, a blank frame, or a stale build?
2. Walk the shortest path a new person takes: the landing page, the one
   call to action, the first screen behind it. Stop before anything that
   charges money, sends mail, or writes data that a person would see.
3. Sign-in page loads and accepts input. Do not sign in on a scheduled
   run: a takeover request with nobody watching is a turn that hangs.
4. Screenshot anything that looks wrong, at a phone width as well.

Append one dated line per product to \`/workspace/qa/health.md\`.

**Send nothing** when every product renders and the path walks.

**Send one short message** with the screenshot attached when something is
broken: what is broken, on which product, and since when if you can tell
from the last run. Open an incident file for anything that is down.`,
});
