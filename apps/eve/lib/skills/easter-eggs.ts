import { defineSkill } from "eve/skills";

import { EASTER_EGGS } from "../vibey/easter-eggs.ts";

/**
 * The egg catalogue as a load-on-demand skill instead of an always-on prompt
 * section: eve advertises this description every turn and the model pulls the
 * full catalogue in via `load_skill` only when a bit is actually invoked, so
 * ordinary turns don't carry ~600 words of persona copy. The description lists
 * every trigger verbatim because it's the routing hint — a miss here means a
 * missed bit (routing guarded by evals/routing/eggs.eval.ts; the list itself is
 * pinned to `EASTER_EGG_COMMANDS` by easter-eggs.test.ts, in both directions).
 */
export default defineSkill({
  description:
    "Use when a message invokes one of vibey's easter-egg bits and you need the persona/joke brief before replying: /elon, /ralph, /roast, /champ, /nicetry, /ultrathink, /slop, /vibecheck, /eggs, /help, or phrasings like 'elon mode', 'do the elon thing', 'make it slop', '3am grok content', 'ultrathink this', 'roast me', 'roast @someone', 'say only nice things about me', 'call me champ', 'refer to me exclusively as big dawg', 'vibe check', 'read the room'.",
  markdown: EASTER_EGGS,
});
