import { defineTool } from "eve/tools";
import { never } from "eve/tools/approval";
import { z } from "zod";

/**
 * Mint a hello.expert desk or plugin link. WhatsApp cannot host a browser, so
 * a link is the only way a human takes the mouse or consents to a new plugin.
 *
 * Phase 1 placeholder: the hub RPC that mints a guest invite
 * (`Agent.CreateInvite`, Phase 2 of `docs/WHATSAPP-PARITY.md`) does not exist
 * yet, so every call answers `available: false` with the one-line fallback.
 * The tool ships now so the prompt, the skill and the evals can already route
 * to it and so the reply shape is pinned before the RPC lands.
 *
 * Not for changing instructions, skills, routines, or tools: those are files.
 * Edit them with `read_file` / `write_file`. Do not call this for an edit.
 */

/** What the Bot says while there is no minting RPC. Never contains a token. */
export const INVITE_UNAVAILABLE_NOTE =
  "Open hello.expert and sign in, I can't mint a link from here";

export default defineTool({
  approval: never(),
  description:
    "Mint a short hello.expert link when a real browser is required: kind=desk if a human wants the mouse/keyboard (say 'Open the desk'), kind=plugin for OAuth consent on a new plugin (say 'Add a plugin'). Not for changing instructions, skills, routines, or computer-use: edit those files on disk instead. Never put a token, setup code, or credential in the reply; only the public URL or the one-line fallback. If it returns available:false, say the note in one sentence and keep chatting.",
  execute(input: { kind: "desk" | "plugin" }) {
    return {
      available: false as const,
      kind: input.kind,
      note: INVITE_UNAVAILABLE_NOTE,
    };
  },
  inputSchema: z.object({
    kind: z
      .enum(["desk", "plugin"])
      .describe(
        "desk = a human takes the mouse. plugin = OAuth consent for a new connection. Never use this to edit instructions, skills, or routines.",
      ),
  }),
});
