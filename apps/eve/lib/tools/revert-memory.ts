import { defineTool } from "eve/tools";
import { z } from "zod";

import { stripAutoBlock } from "../vibey/consolidation.ts";
import { canSaveMemory } from "../vibey/memory-internal.ts";
import {
  appendMemoryWrite,
  blobConfigured,
  memoryKey,
  mutateJson,
  readMemoryWrites,
} from "../vibey/memory-store.ts";
import type { GroupMemory } from "../vibey/memory-store.ts";
import { groupJidFromAuth, senderJidFromAuth } from "../vibey/session.ts";

/**
 * Undo a memory change by its id, restoring the exact prior text.
 *
 * This is the human control on autonomous writes, and it is deliberately the
 * same `canSaveMemory` gate the manual save path uses rather than a new one: a
 * revert is a write, so it answers to the same authority. It works from a DM as
 * well as the group. The routing wrinkle that used to apply here is gone: the
 * bridge sent an OWNER's untagged DM to a separate second-brain agent, so
 * Matthew had to tag @Vibey for a DM to reach this agent at all. That route was
 * removed with that agent's WhatsApp surface, and every member DM (his
 * included) now lands here untagged.
 *
 * Reverting an automatic write strips just that tagged line, leaving human prose
 * and other automatic blocks intact. Reverting a human write restores the
 * category's previous text wholesale, since that write replaced it wholesale.
 */
export default defineTool({
  description:
    "Undo a specific change to @vibey's memory for this chat using the id from memory-log or the overnight report (e.g. 'revert memory a1b2c3'). Use when someone says a remembered fact is wrong, or asks to undo/remove something @vibey wrote about the group. Call memory-log first if you don't have the id.",
  async execute(input, ctx) {
    const gate = canSaveMemory(groupJidFromAuth(ctx.session.auth));
    if (!gate.ok) {
      return { reason: gate.reason, reverted: false };
    }
    if (!blobConfigured()) {
      return { reason: "memory backend unavailable", reverted: false };
    }

    const writes = await readMemoryWrites(gate.groupJid);
    const target = writes.find((w) => w.id === input.id);
    if (!target) {
      return {
        knownIds: writes.slice(-10).map((w) => w.id),
        reason: `no memory change with id ${input.id} in the last 90 days`,
        reverted: false,
      };
    }

    try {
      const next = await mutateJson<GroupMemory>(memoryKey(gate.groupJid), (current) => {
        const memory = { ...current };
        const existing = memory[target.category] ?? "";
        // An auto write is surgical: drop only its tagged line. An admin
        // write replaced the whole category, so undo restores it wholesale.
        memory[target.category] =
          target.source === "auto" ? stripAutoBlock(existing, target.id) : (target.previous ?? "");
        return memory;
      });

      // The revert is itself an auditable change, so it goes in the log too —
      // otherwise the trail would show a write with no record of its undo.
      await appendMemoryWrite(gate.groupJid, {
        by: senderJidFromAuth(ctx.session.auth) ?? "unknown",
        category: target.category,
        content: next?.[target.category] ?? "",
        id: `r_${target.id}`,
        previous: target.content,
        reason: `revert of ${target.id} (${target.reason})`,
        source: "admin",
        t: Math.floor(Date.now() / 1000),
      });

      return {
        category: target.category,
        note: "Reverted. The change may take up to a minute to disappear from @vibey's context, because memory reads are CDN-cached.",
        reverted: true,
        was: target.content.slice(0, 200),
      };
    } catch (error) {
      return { error: String(error), reason: "revert failed", reverted: false };
    }
  },
  inputSchema: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe("The change id from memory-log or the overnight report, e.g. 'a1b2c3'."),
  }),
});
