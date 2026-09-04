import { defineDynamic, defineInstructions } from "eve/instructions";
import { hubRpc } from "../hub.ts";

/**
 * Who this Bot is, from the computer rather than from this project.
 *
 * A Bot that came with the build is its directory: its brief is
 * `agent/instructions.md` in git and changing it is a deploy. A Bot made in
 * the browser, or made from someone's shared template, has no directory and
 * runs `apps/eve/bots/template`, so everything that makes it itself lives on
 * the box instead: its profile, the brief a template wrote, the facts it has
 * kept, and the index of its skills. `Agent.Identity` is the hub handing that
 * over already composed (`BotState.prompt`), and this is what folds it into
 * the prompt.
 *
 * Without it the identity is written and read by nobody: applying a template
 * would put files on the volume that no turn ever sees, and the profile a
 * person types into the settings sheet would be decoration.
 *
 * Per turn rather than per session, deliberately. Renaming a Bot, rewriting
 * its brief or installing a template should land on the next thing it does,
 * not on the next conversation. It is a short, stable string, so what it
 * costs a provider's prompt cache is a few hundred tokens at the tail.
 *
 * Nothing here is fatal. A hub that is not answering, or one older than this
 * RPC, leaves the Bot with its project's own instructions, which is what
 * every Bot had before this existed.
 */
export default defineDynamic({
  events: {
    "turn.started": async () => {
      let prompt = "";
      try {
        const identity = await hubRpc<{ prompt?: unknown }>("identity", {});
        prompt = typeof identity.prompt === "string" ? identity.prompt : "";
      } catch {
        return null;
      }
      return prompt.trim() ? defineInstructions({ content: prompt }) : null;
    },
  },
});
