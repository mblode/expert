import { defineTool } from "eve/tools";
import { z } from "zod";

import { blobConfigured, readMemoryWrites } from "../vibey/memory-store.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * Shows what @vibey has written to its own memory, with the revert handles.
 *
 * Open to everyone in the chat, like the write path itself. Transparency is
 * what makes autonomous writes acceptable for a bot that writes on its own, so
 * the log is the one part that was never gated even when saving was.
 */
export default defineTool({
  description:
    "Show recent changes to @vibey's memory for this chat — what was written, when, by whom (a person or the overnight pass), and the id needed to revert it. Use when someone asks what @vibey has learned or remembered lately, why it thinks something, where a fact came from, or how to undo a memory change. Anyone can call this, and anyone can revert with revert-memory.",
  async execute(input, ctx) {
    const jid = groupJidFromAuth(ctx.session.auth);
    if (!(blobConfigured() && jid)) {
      return {
        available: false,
        note: "The memory log isn't available here.",
      };
    }

    const writes = await readMemoryWrites(jid);
    if (writes.length === 0) {
      return {
        available: true,
        entries: [],
        note: "No memory changes recorded in this window.",
      };
    }

    // Newest first: someone asking "what changed" almost always means "lately".
    const entries = writes
      .toSorted((a, b) => b.t - a.t)
      .slice(0, input.limit ?? 20)
      .map((w) => ({
        by: w.source === "auto" ? "overnight pass" : w.by,
        category: w.category,
        id: w.id,
        reason: w.reason,
        source: w.source,
        // Enough to recognise the change without dumping a whole category.
        text: w.content.length > 300 ? `${w.content.slice(0, 300)}…` : w.content,
        when: new Date(w.t * 1000).toISOString().slice(0, 16).replace("T", " "),
      }));

    return {
      available: true,
      entries,
      note: "Entries marked 'overnight pass' were written by @vibey on its own. Anyone can undo one with revert-memory using the id.",
    };
  },
  inputSchema: z.object({
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max entries to return, newest first. Default 20."),
  }),
});
