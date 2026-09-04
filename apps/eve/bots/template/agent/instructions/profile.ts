import { defineDynamic, defineInstructions } from "eve/instructions";
import { botIdentityPrompt } from "../../../../lib/profile.ts";

/**
 * The half of `instructions.md` that cannot be a file in git.
 *
 * Every Bot made at runtime runs this one project, so the code is shared and
 * the profile is the whole difference between two of them. It is read per
 * turn rather than per session because the human renames a Bot from the
 * settings sheet mid-conversation, and a Bot that keeps introducing itself by
 * the name it had an hour ago is the bug this exists to close. The content is
 * unchanged between turns when the profile is, so the prompt prefix a
 * provider caches is unchanged with it.
 */
export default defineDynamic({
  events: {
    "turn.started": async () => {
      const content = await botIdentityPrompt();
      return content ? defineInstructions({ content }) : null;
    },
  },
});
