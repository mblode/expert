import { defineTool } from "eve/tools";
import { z } from "zod";

import { bridgeConfigured, bridgePost } from "../vibey/bridge-client.ts";
import { senderNameFromAuth } from "../vibey/session.ts";

/**
 * Forward an idea, request, or bug report to the maintainer (Matthew) as a
 * WhatsApp DM, via the bridge's `/report` endpoint. There's no issue tracker
 * yet, so this is the lightweight backlog: asks reach Matthew directly instead
 * of getting lost in the chat.
 *
 * Scope is deliberately wide — vibey *or* VCMC / the group, including events,
 * community ideas, jokes, and compliments, not just agent features. The model
 * used to invent extra gates ("not a vibey feature", "too big", "just a joke")
 * and bounce real asks; Matthew wants those forwarded. Skip only idle chat
 * where nobody asked you to flag anything.
 *
 * The bridge dedupes repeat reports and DMs a configured maintainer JID; if the
 * bridge is unreachable or has no maintainer configured it reports back
 * `reported: false` rather than throwing, matching the other bridge tools.
 */

export default defineTool({
  description:
    "Forward a message, idea, request, or bug report to Matthew, the maintainer, as a private message. Use it when someone wants something flagged to Matt — an idea for @vibey or for VCMC / the group, a bug, a joke, a compliment, anything they asked you to pass on. Don't refuse because it's a group event, a community idea, too big, a roadmap, 'not a vibey feature', or just a joke — pass it on and let Matthew decide. Skip only idle chat where nobody asked you to flag anything. Make ONE call per distinct request with a tight one-line summary. Tell the member you've passed it to Matthew; don't promise it'll be built or give a timeline. Returns `reported: true` when it was delivered (or `duplicate: true` if the same request was already forwarded).",
  async execute(input, ctx) {
    if (!bridgeConfigured()) {
      return {
        available: false,
        note: "Reporting is only available when connected to the WhatsApp bridge.",
      };
    }
    try {
      const data = await bridgePost<{
        delivered?: boolean;
        duplicate?: boolean;
      }>("/report", {
        details: input.details,
        kind: input.kind,
        requestedBy: senderNameFromAuth(ctx.session.auth),
        summary: input.summary,
      });
      return {
        duplicate: Boolean(data.duplicate),
        reported: Boolean(data.delivered),
      };
    } catch (error) {
      // Match the read tools: degrade instead of throwing out of the turn.
      return { error: String(error), reported: false };
    }
  },
  inputSchema: z.object({
    details: z
      .string()
      .trim()
      .max(1000)
      .optional()
      .describe("Optional extra context: steps to reproduce a bug, the use case behind a request."),
    kind: z.enum(["feature", "bug"]).describe("Whether this is a feature request or a bug report."),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(280)
      .describe("One-line summary of the request or bug, in plain language."),
  }),
});
