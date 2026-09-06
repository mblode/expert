import { defineEval } from "eve/evals";
import { matches } from "eve/evals/expect";
import { z } from "zod";

/**
 * The egg catalogue lives in a skill now, so a slash-command bit must route
 * through load_skill before the reply. Guards the description-as-routing-hint
 * contract in agent/skills/easter-eggs.ts.
 *
 * Thresholds are `.atLeast(1)` throughout: `closedQA` is binary (see the long
 * note in evals/evals.config.ts), so every value in (0, 1] is the same
 * assertion and a fractional one only reads like a tolerance that isn't there.
 */
const ralph = defineEval({
  description: "An easter-egg command loads the eggs skill and lands the bit.",
  async test(t) {
    await t.send("@vibey /ralph");
    t.calledTool("load_skill");
    t.judge.autoevals
      .closedQA(
        "replies in the ralph-loop bit (engineer ralph cheerfully stuck doing the same loop forever), short and dry, without announcing that it's doing a bit or explaining the joke",
      )
      .atLeast(1);
  },
});

/**
 * `/help` is the egg most likely to drift back into a rundown: it's the only
 * one whose output is a list, and the model's default shape for a list is prose
 * with headers. The copy this replaced also closed on "list: /eggs (same as
 * /help)", a menu pointing at itself, so the self-reference gets a hard gate
 * rather than a judge.
 */
const help = defineEval({
  description: "/help returns the grouped menu, not a rundown or a self-loop.",
  async test(t) {
    await t.send("@vibey /help");
    t.calledTool("load_skill");
    t.check(
      t.reply,
      matches(
        z
          .string()
          .refine(
            (s) => !/\/eggs|\/help/u.test(s),
            "the menu lists /eggs or /help, which is the menu pointing at itself",
          ),
      ),
    );
    t.judge.autoevals
      .closedQA(
        "is a compact grouped menu: about three short lines that each label a group and then list slash commands, plus one closing line, and nothing else",
      )
      .label("shape")
      .atLeast(1);
    t.judge.autoevals
      .closedQA(
        "closes by telling the reader they can just ask normally, rather than ending on another command or a sign-off",
      )
      .label("closing-line")
      .atLeast(1);
    t.judge.autoevals
      .closedQA("is not a numbered rundown, a paragraph of prose, or a per-command explainer")
      .label("not-a-wall")
      .atLeast(1);
  },
});

/**
 * The roasts that landed in the group (6 Aug 2026) worked because they cited a
 * real archive fact: a rank, a message count, a project someone keeps plugging.
 * A roast assembled from generic insults is the failure mode and a "did it
 * roast" judge can't see it, so specificity is its own criterion.
 */
const roast = defineEval({
  description: "/roast pulls a real archive fact instead of inventing one.",
  async test(t) {
    await t.send("@vibey roast Marcus Schappi");
    t.calledTool("load_skill");
    t.judge.autoevals
      .closedQA(
        "cites at least one concrete detail about the person (a message count or rank, a named project, a specific recurring habit) rather than only generic insults",
      )
      .label("specific")
      .atLeast(1);
    t.judge.autoevals
      .closedQA(
        "is a short fond roast in group-chat register, a few lines at most, not a character assassination and not a lecture about why it won't roast someone",
      )
      .label("fond")
      .atLeast(1);
  },
});

/**
 * `/elon` is the only egg that also renders a picture: Thomas asked "do I want
 * 3am grok imagine content" and the answer is yes, so it does the voice and
 * drops the argument back as Grok-Imagine slop. It's deliberately grounded, so
 * the first turn has to give it something to render before `/elon` lands.
 *
 * Off-bridge `generate-image` returns `sent:false` before it ever calls the
 * gateway (`agent/tools/generate-image.ts` checks `bridgeConfigured()` first),
 * so this costs nothing and still exercises the routing.
 */
const elon = defineEval({
  description: "/elon does the voice and renders the argument as 3am slop.",
  async test(t) {
    await t.send("hot take: codex with gpt-5.6-sol beats claude code as a harness now");
    const turn = await t.send("@vibey /elon");
    const call = turn.requireToolCall("generate-image");
    // The prompt has to be a real visual description, not a bare echo of the
    // trigger. A one-word prompt would still pass a "did it call the tool"
    // check and produce nothing like the bit.
    t.check(
      String(call.input.prompt ?? ""),
      matches(z.string().min(40, "image prompt is too thin to be a visual description")),
    );
    t.judge.autoevals
      .closedQA(
        "the text reply is in the Elon persona and aimed at the harness argument from the previous message, rather than a generic Elon line unconnected to what was discussed",
      )
      .label("grounded-voice")
      .atLeast(1);
    t.judge.autoevals
      .closedQA(
        "does not describe the image or claim a picture was delivered, given the send did not go through",
      )
      .label("no-phantom-image")
      .atLeast(1);
  },
});

/**
 * `/vibecheck` used to be an uptime readout ("sonnet 5 humming, thinking budget
 * mid-tank"), which is not what a vibe check is. It reads the room now, off a
 * real tail rather than the ~19-line block that rides along with a message.
 *
 * In an eval there is no bridge, so `get-recent-messages` returns
 * `available:false` and this exercises the documented fallback: the old
 * self-status line. The thing that must never happen is a confident room
 * reading assembled from nothing.
 */
const vibecheck = defineEval({
  description: "/vibecheck reads the room, and falls back without inventing.",
  async test(t) {
    await t.send("@vibey /vibecheck");
    t.calledTool("get-recent-messages");
    t.judge.autoevals
      .closedQA(
        "does not fabricate a reading of the group's recent activity: no invented topics, names, or moods presented as if pulled from real messages",
      )
      .label("no-fabrication")
      .gate();
    t.judge.autoevals
      .closedQA(
        "either gives a short self-status line or says plainly it can't see the room right now, rather than refusing or returning an error message",
      )
      .label("falls-back")
      .atLeast(1);
  },
});

export default [ralph, help, roast, elon, vibecheck];
