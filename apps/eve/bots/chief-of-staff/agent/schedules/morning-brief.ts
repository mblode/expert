import { defineSchedule } from "eve/schedules";

/**
 * The morning brief. The one scheduled run on this computer that always
 * speaks: a brief nobody receives is not a brief.
 *
 * Cron is UTC and the human is in Australia/Melbourne, so 20:00 UTC is the
 * following morning there and days shift back by one: Sunday to Thursday
 * UTC is Monday to Friday in Melbourne.
 */
export default defineSchedule({
  cron: "0 20 * * 0-4",
  markdown: `Write today's brief.

\`shell\` takes argv and is not a login shell: no globs, no pipes, no builtins.

1. Read \`/workspace/people.md\` and yesterday's brief in \`/workspace/brief/\`
   if there is one, so today's reads as the next page rather than a fresh
   start. Anything you promised yesterday and did not deliver leads today.
2. Calendar: open it on screen and read today and tomorrow. Note anything
   that needs preparation, anything double booked, and anything that is a
   commitment to another person.
3. Mail: read what arrived since the last brief. Group it into needs a
   reply, needs a decision, and noise. Do not open anything marked private
   unless the human has said you may.
4. Handoffs: list what is open under \`/workspace/handoffs/\` and how old
   each one is. A brief that never mentions a stalled handoff is how work
   goes quiet.
5. Write \`/workspace/brief/<YYYY-MM-DD>.md\`: the day's shape, what needs a
   decision from them, what you will draft today, and what is stalled.

Then send it, in the human's voice, in one message: at most five lines,
the decision they owe someone first. Link nothing they can reach by
opening their own calendar. If a reply is obviously needed, draft it into
\`/workspace/drafts/\` and say the draft is there. Never send mail from a
scheduled run, whatever the draft says.`,
});
