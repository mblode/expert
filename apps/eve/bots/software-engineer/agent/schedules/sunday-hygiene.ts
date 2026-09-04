import { defineSchedule } from "eve/schedules";

/**
 * Sunday hygiene: the maintenance nobody asks for and everybody needs.
 *
 * Cron is UTC and the human is in Australia/Melbourne, so Saturday 21:00
 * UTC is Sunday morning there.
 */
export default defineSchedule({
  cron: "0 21 * * 6",
  markdown: `Weekly hygiene across the repos in \`/workspace/src\`. Nobody
asked for this, so speak only if something needs a person.

\`shell\` takes argv and is not a login shell: no globs, no pipes, no builtins.

For each repo listed in \`/workspace/products.md\`:

1. \`git -C <repo> fetch origin\` and check the default branch is green:
   read the latest run of its checks. A red default branch is the one
   finding that always deserves a message.
2. Dependencies: list what is outdated and what has an advisory. Patch
   and minor updates with a green build are worth a PR; a major is a
   note, not a PR.
3. Dead weight: branches merged more than a month ago, files nothing
   imports, dependencies nothing requires, TODOs older than the last
   release.
4. Append what you found to \`/workspace/notes/engineering.md\` under
   today's date, one line per repo.

Then decide.

**One draft PR at most**, and only for the safest thing you found:
dependency patches with a green build, or a delete of something provably
unreferenced. Same rules as any run: tests pass, draft, never merged.

**Send nothing** when every default branch is green, nothing is
outdated, and you opened no PR. A weekly "all good" trains them to
ignore you.

**Send one short message** when a default branch is red, an advisory
needs a decision, or you opened the PR: what it is, and the one thing you
suggest.`,
});
