import { defineTool } from "eve/tools";
import { z } from "zod";

import { groupHistory } from "../vibey/group-history.ts";

/**
 * The group's own story: a curated timeline of in-group moments (who joined, the
 * meetups, the debates the group had, running gags) plus short reference prose on
 * the group's origin, themes, meetups and OpenAI relationship. Use for "what's
 * the group been through", "when did X join", "history of VCMC", "what's the
 * deal with the meetups / OpenAI". This is in-group lore, not external news —
 * it deliberately holds no model prices, benchmarks or version specs, so for
 * anything current/external use web_search instead.
 */

export default defineTool({
  description:
    "VCMC's own history: a curated timeline of in-group moments (members joining, meetups, debates the group had, running gags) and short context on the group's origin, recurring themes, meetups and OpenAI relationship. Use for 'what's the group been through', 'when did X join', 'history of VCMC', 'tell me about the meetups'. In-group lore only — for current/external facts (prices, benchmarks, releases) use web_search.",
  // oxlint-disable-next-line require-await -- tool handlers are async by contract; this one reads static data
  async execute(input) {
    const q = input.query?.trim().toLowerCase();
    const personQ = input.person?.trim().toLowerCase();

    const history = groupHistory();
    if (history.timeline.length === 0) {
      // A computer with no `group-history.json` is not this community.
      return {
        available: false,
        note: "This computer has no group history to draw on.",
      };
    }
    let entries = history.timeline;
    if (personQ) {
      entries = entries.filter((e) => e.people?.some((p) => p.toLowerCase().includes(personQ)));
    }
    if (q) {
      entries = entries.filter(
        (e) =>
          e.summary.toLowerCase().includes(q) || e.people?.some((p) => p.toLowerCase().includes(q)),
      );
    }

    const limit = input.limit ?? 40;
    return {
      // Only ship the reference prose on an unfiltered ask, to keep replies tight.
      context: q || personQ ? undefined : history.context,
      matched: entries.length,
      timeline: entries.slice(0, limit),
    };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("Max timeline entries to return (default 40)."),
    person: z
      .string()
      .optional()
      .describe("Optional: only moments involving this person (substring match on name)."),
    query: z
      .string()
      .optional()
      .describe("Optional: filter the timeline by keyword (substring match on the summary)."),
  }),
});
