import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

/**
 * The only *deterministic* voice guard in the suite. It used to be decorative:
 * both `t.check`s called `.soft()` with no threshold, and eve's `computePassed`
 * resolves that to `threshold ?? (severity === "gate" ? 1 : undefined)`, i.e.
 * `undefined` for a soft assertion, which passes unconditionally. Every run was
 * green by construction. Both now carry a real threshold, split by whether the
 * defect actually reaches the group:
 *
 *  - Slop words are a `.gate()`. Nothing downstream removes them, so a banned
 *    word in the model's output is a banned word in the WhatsApp message.
 *  - Em/en dashes are `.atLeast(1)` (soft, but thresholded, so `--strict` fails
 *    on them). `cleanReply` in `agent/lib/format-reply.ts` rewrites dashes to
 *    commas on the way out, so a raw dash is never *seen* by the group. What
 *    it measures is the model's raw tendency, which is worth tracking (it's the
 *    leading indicator that the prompt's voice section has drifted) without
 *    hard-failing a build over something the output filter already handles.
 *    `npm run test:evals` runs `--strict`, so it does fail there.
 *
 * The word list is the "No AI tells" banned list from `base-instructions.ts`,
 * minus "harness" (the noun, an agent harness, is normal vocabulary here) and
 * minus the phrases whose false-positive risk outweighs the signal. Keep the
 * two in sync when the prompt's list changes.
 *
 * Fanned out over three phrasings of the same comparative-take ask. Every
 * assertion here is one sample of a stochastic model, and the judge below is
 * binary, so a single run is close to a coin flip. Three phrasings give three
 * independent samples *and* localise a failure to a specific wording. Note the
 * ids are separate evals (`voice/no-ai-tells/0000`…), so the run fails if any
 * one of them fails: this trades a higher false-failure rate for catching
 * drift that a single lucky sample would hide.
 */
const SLOP =
  /\b(?<slop>delve|leverage|robust|seamless|pivotal|intricate|unlock|empower|facilitate|testament to|cutting-edge|streamline|showcase|utili[sz]e|elevate|foster|actionable|impactful|learnings|holistic|crucial|nuanced|boasts|moreover|furthermore|that said|in conclusion|when it comes to|let['’]s dive in|deep dive)\b/iu;

const PROMPTS = [
  "what's the take on opus 4.8 vs codex in here?",
  "@vibey is claude code actually better than cursor these days or is that just vibes",
  "@vibey what did people land on for mcp servers, anything actually worth wiring up?",
] as const;

export default PROMPTS.map((prompt) =>
  defineEval({
    description: `Replies in the group's voice, no em dashes or AI-slop words: "${prompt}"`,
    async test(t) {
      await t.send(prompt);
      t.check(
        t.reply,
        matches(z.string().refine((s) => !/[—–]/u.test(s), "raw reply has an em/en dash")),
      ).atLeast(1);
      t.check(
        t.reply,
        matches(z.string().refine((s) => !SLOP.test(s), "raw reply has a banned slop word")),
      ).gate();
      // `closedQA` is binary (autoevals scores the judge's Y/N as 1.0/0.0), so
      // every threshold in (0, 1] means the same thing: "the judge had to say
      // yes". The old `.atLeast(0.6)` read like a tolerance and wasn't one.
      // Where gradation is actually wanted, it has to come from splitting the
      // criterion, which is what these two calls do: register and sourcing
      // fail for different reasons and want to be diagnosable apart.
      t.judge.autoevals
        .closedQA(
          "sounds like a knowledgeable member of a builders' group chat rather than a corporate assistant: plain, terse language with no AI preamble, no sign-off, and no hedging",
        )
        .label("register")
        .atLeast(1);
      t.judge.autoevals
        .closedQA(
          "grounds the take in named people or specific messages from the group rather than generic commentary that could have been written without reading the chat",
        )
        .label("sourcing")
        .atLeast(1);
    },
  }),
);
