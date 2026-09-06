import { defineDynamic, defineInstructions } from "eve/instructions";

import { buildGroupMemoryPrompt, fetchGroupMemory } from "../vibey/memory-internal.ts";
import { groupJidFromAuth } from "../vibey/session.ts";

/**
 * Per-chat long-term memory, appended to the system prompt at session start.
 *
 * The identity is not here. `agent/instructions.md` is the generic default and
 * the hub's runtime instructions (`instructions/runtime.ts`, edited from
 * hello.expert) are what make one computer Vibey; eve composes the root file,
 * then this directory's entries in filename order. What varies per session
 * and lives nowhere else is the stored memory: keyed by chat JID (the group in
 * a group, the DM in a DM) on Vercel Blob, so each chat carries its own
 * standing facts into every turn. Outside a WhatsApp chat (the eve TUI, the
 * hello.expert thread) there is no JID and this contributes nothing.
 *
 * `null` from the store (backend unreachable) renders no block, the same as
 * genuinely empty: the Bot then says nothing about memory rather than
 * asserting it is blank.
 */
export default defineDynamic({
  events: {
    "session.started": async (_event, ctx) => {
      const jid = groupJidFromAuth(ctx.session.auth);
      if (!jid) {
        return null;
      }
      const memory = await fetchGroupMemory(jid);
      const block = buildGroupMemoryPrompt(memory ?? {});
      return block ? defineInstructions({ content: block }) : null;
    },
  },
});
