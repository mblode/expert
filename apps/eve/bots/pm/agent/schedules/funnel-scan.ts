import { defineSchedule } from "eve/schedules";

/**
 * The weekly funnel scan: measure, re-rank, and read anything that is due.
 *
 * Weekly rather than daily on purpose. Conversion data has a seven day
 * cycle, so a daily scan reads noise and a daily message trains the human
 * to ignore this Bot. Cron is UTC; 22:00 Sunday is Monday morning in
 * Australia/Melbourne.
 */
export default defineSchedule({
  cron: "0 22 * * 0",
  markdown: `Weekly funnel scan across the products in
\`/workspace/products.md\`. Nobody asked for this, so speak only if
something needs a person.

1. For each product, pull the funnel for the last two full weeks. Record
   n, the drop at each step, the window dates, and the query, per
   \`skills/opportunity\`.
2. Compare against the previous entry in
   \`/workspace/pm/opportunities.md\`. A step that got worse by more than
   noise is the finding; the rest is bookkeeping.
3. Re-rank by people lost. Rewrite the list with today's date.
4. Read \`/workspace/pm/experiments/\` for anything whose end date has
   passed. Run \`skills/readout\` on it now, that is what the date was for.
5. Check that no product has two experiments in flight. If one does, say
   so: that is a broken result, not a scheduling problem.

**Send nothing** when no step moved beyond noise, nothing is due to be
read, and the ranking is unchanged.

**Send one short message** when an experiment is ready to read (lead with
the verdict), a step got materially worse, or the top Opportunity
changed. One paragraph, the number first.

Never start an experiment from a scheduled run. Starting one is a
decision, and the human makes it.`,
});
