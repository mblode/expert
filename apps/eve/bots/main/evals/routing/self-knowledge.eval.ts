import { defineEval } from "eve/evals";

/**
 * vibey names the real stack (eve + Claude sonnet) rather than guessing, and
 * says it in voice.
 *
 * This used to assert `usedNoTools()`, because the whole architecture section
 * sat in the always-on prompt. It now lives in the `how-im-built` skill, so the
 * expectation flips: one `load_skill` call, then the answer. The voice
 * criterion is the point of this case and is unchanged; whether routing fires
 * on other phrasings is `evals/routing/skills.eval.ts`.
 */
export default defineEval({
  description: "Knows its own architecture and answers it in voice after loading the skill.",
  async test(t) {
    await t.send("@vibey out of interest, how were you actually built? what's your stack");
    t.loadedSkill("how-im-built");
    t.judge.autoevals
      .closedQA(
        "explains it's an eve agent running on Claude (sonnet) wired into WhatsApp, accurately and concisely, in a casual builder voice rather than a structured corporate rundown",
      )
      .atLeast(0.7);
  },
});
