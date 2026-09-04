import { defineSchedule } from "eve/schedules";

/**
 * Weekday health: the checks a person would run if they had the time.
 *
 * Cron is UTC and the human is in Australia/Melbourne, so 21:00 UTC Sunday
 * to Thursday is Monday to Friday morning there.
 */
export default defineSchedule({
  cron: "0 21 * * 0-4",
  markdown: `Morning health check across the products in
\`/workspace/products.md\`. Nobody asked for this, so speak only if
something needs a person.

\`shell\` takes argv and is not a login shell: no globs, no pipes, no builtins.

For each product:

1. Reach its public URL and its health endpoint. Record the status and the
   response time. A redirect to a sign-in page is a healthy public site;
   a 500 is not.
2. Read the default branch's latest CI run in its repo. Red counts as a
   finding even when nothing is deployed from it.
3. Open pull requests: any that have been red for more than a day, and
   any that have been open more than two weeks.
4. Read the last entry in \`/workspace/qa/regression.md\`. Anything that
   broke before and has no test yet is still an open finding.

Append one dated line per product to \`/workspace/qa/health.md\`: the
status and either \`ok\` or what was wrong.

Then decide.

**Send nothing** when every product answers, every default branch is
green, and nothing has been red or stale for more than a day.

**Send one short message** otherwise: what is failing, who it affects,
and the one thing you suggest. Fix only what \`skills/ci-triage\` calls
clearly this change's fault, as a draft PR. A scheduled run has nobody
watching, so anything beyond reading and one small fix waits.`,
});
