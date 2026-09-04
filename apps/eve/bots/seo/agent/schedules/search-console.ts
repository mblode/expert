import { defineSchedule } from "eve/schedules";

/**
 * The weekly Search Console read. Weekly because Search Console data lands
 * two to three days late and search itself moves in weeks: a daily check
 * reads noise and reports it as a trend.
 *
 * Cron is UTC; 22:00 Sunday is Monday morning in Australia/Melbourne.
 */
export default defineSchedule({
  cron: "0 22 * * 0",
  markdown: `Weekly Search Console read for the sites in
\`/workspace/products.md\`. Nobody asked for this, so speak only if
something needs a person.

Read \`skills/screen\` first; Search Console is behind a sign-in on my
screen. Compare the last full week against the previous one, and against
the same week a year ago where there is data.

1. **Clicks and impressions** per site. Note the direction and the size.
   A move under about 10% on a small site is noise; say nothing.
2. **Queries that moved**: new queries with impressions, and queries that
   lost most of theirs. The second is the one that matters.
3. **Pages that lost**: any page down more than a third in clicks.
4. **Coverage**: new errors, new exclusions, anything newly \`noindex\`
   or blocked by robots.txt. This is the only section where one page is
   worth a message.
5. **Manual actions and security issues**: check every week. If one
   exists, that is the message, and it goes out immediately.

Append a dated block per site to \`/workspace/seo/console.md\`: the two
numbers, what moved, and what you did about it.

**Send nothing** on a quiet week.

**Send one short message** when clicks dropped materially, a page fell
out of the index, coverage errors appeared, or there is a manual action.
Say what it is, which pages, and the one thing you suggest. Technical
fixes go through \`skills/technical-search\` as a draft PR, one class of
problem at a time, and never robots.txt or canonicals from a scheduled
run: propose those and let a person look.`,
});
