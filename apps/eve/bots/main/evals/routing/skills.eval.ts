import { defineEval } from "eve/evals";

/**
 * Three sections moved out of the always-on prompt and into load-on-demand
 * skills (`how-im-built`, `group-lore`, `matthew-blode`), which took the base
 * prompt from ~31.7k chars to ~24.3k. That trade only pays if routing is
 * reliable: a miss doesn't degrade the answer politely, it produces a confident
 * "I don't have that" about something @vibey has always known.
 *
 * So each skill gets a probe in the phrasing a member would actually use, and
 * each asserts that THAT skill loaded and that the answer landed. `loadedSkill`
 * rather than `calledTool("load_skill")` on purpose: the bare form passes when
 * the wrong skill loads and the model answers acceptably anyway, which is the
 * routing miss these exist to catch. The eggs skill has its own file
 * (`evals/routing/eggs.eval.ts`) because its routing surface is a list of
 * triggers rather than a topic.
 *
 * Thresholds are `.atLeast(1)`: `closedQA` is binary (see evals/evals.config.ts),
 * so any value in (0, 1] is the same assertion.
 *
 * One consequence of that binary grading: a criterion asserting two independent
 * properties fails whenever EITHER slips, and reports one score, so a flake and
 * a real regression look identical. The compound criteria here were split into
 * named judges after exactly that, three runs disagreeing on the same correct
 * replies. Ask one thing per criterion, and only about what the probe invites:
 * the first draft of the cron case also demanded the answer mention DMs, which
 * the question never raised and `Give what was asked, not everything you know`
 * tells @vibey not to volunteer.
 */

const howImBuilt = defineEval({
  description: "An architecture question loads the how-im-built skill.",
  async test(t) {
    await t.send("@vibey do you run on a cron or only when someone tags you?");
    t.loadedSkill("how-im-built");
    t.judge.autoevals
      .closedQA(
        "says it doesn't post to the group on a timer: it runs when someone mentions it, and the one scheduled job is a private recap DM to members who opted in",
      )
      .label("answers-the-cron-question")
      .atLeast(1);
    t.judge.autoevals
      .closedQA(
        "a couple of short lines, not a structured rundown with headings or a bulleted stack",
      )
      .label("terse")
      .atLeast(1);
  },
});

const groupLore = defineEval({
  description: "A lore reference loads the group-lore skill.",
  async test(t) {
    await t.send("@vibey what does factorio not starcraft actually mean");
    t.loadedSkill("group-lore");
    t.judge.autoevals
      .closedQA(
        "explains it as treating models like automation building blocks you compose, rather than units you micromanage, in a line or two and without attributing the saying to a named member",
      )
      .atLeast(1);
  },
});

const matthewBlode = defineEval({
  description: "A question about Matthew loads the matthew-blode skill.",
  async test(t) {
    await t.send("@vibey what's matt actually built before this?");
    t.loadedSkill("matthew-blode");
    t.judge.autoevals
      .closedQA(
        "names real things from his background (for example VenueSafe, Fingertip, Linktree, Blode UI or agent-skills) rather than deflecting or inventing projects",
      )
      .label("real-projects")
      .atLeast(1);
    t.judge.autoevals
      .closedQA("a couple of lines rather than reciting the whole project list")
      .label("not-a-dump")
      .atLeast(1);
  },
});

/**
 * The counter-case, and the one most likely to regress: "ask Matthew about
 * that" is a routing decision @vibey makes several times a day, and it needs no
 * biography. If this starts loading the skill, the description is too broad and
 * every deferral is paying for a skill load.
 *
 * Scoped to `matthew-blode` rather than any skill: a capability question can
 * legitimately pull `how-im-built`, so failing on every load would report a
 * broad biography description as the cause of something else entirely.
 */
const computerUse = defineEval({
  description: "A desk/screenshot ask loads the computer-use skill.",
  async test(t) {
    await t.send(
      "@vibey can you open github.com/mblode/vcmc-agent on the computer and screenshot the readme",
    );
    t.loadedSkill("computer-use");
    t.judge.autoevals
      .closedQA(
        "treats this as a request to drive the shared computer (open the repo / take a screenshot), not as a question it can only answer from memory, and does not claim it has no computer",
      )
      .atLeast(1);
  },
});

const noSkillForDeferral = defineEval({
  description: "Pointing someone at Matthew doesn't load a skill.",
  async test(t) {
    await t.send("@vibey can you add me to the admin list?");
    t.loadedSkill("matthew-blode", { count: 0 });
    t.judge.autoevals
      .closedQA(
        "says it can't do that and that it's Matthew's call, briefly, without a biography of Matthew and without adjudicating whether the person should be an admin",
      )
      .atLeast(1);
  },
});

export default [howImBuilt, groupLore, matthewBlode, computerUse, noSkillForDeferral];
