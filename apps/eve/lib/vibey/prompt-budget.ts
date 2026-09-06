import { MEMORY_CATEGORIES } from "./memory-categories.ts";
import { buildGroupMemoryPrompt } from "./memory-internal.ts";

/**
 * A size budget for the assembled system prompt.
 *
 * Nothing else in this repo measures the prompt, and it has two growth paths
 * that pull in opposite directions on attention: `base-instructions.ts` grows
 * every time a behaviour is corrected by adding a rule, and the group memory
 * block grows *unattended* — the overnight consolidation pass appends prose to
 * it every night and no code caps a category's length. Both land in front of
 * every single turn, so the failure is quiet: replies get worse before anything
 * errors.
 *
 * This mirrors the assembly in `instructions/memory.ts` (base, then the rendered
 * `<group_memory>` block, joined by a `---` rule) so the number means the same
 * thing as what the model actually receives.
 *
 * Skills are deliberately not counted. Their bodies only enter the prompt when
 * the model calls `load_skill`, so folding them in would measure a turn that
 * mostly doesn't happen. What each skill does cost every turn is its
 * `description`, which eve advertises as the routing hint; those are a line
 * each and are the reason to be sparing about adding skills, not about their
 * length.
 *
 * Chars, not tokens: a tokeniser would be a dependency and a moving target, and
 * the ratio is stable enough (~4 chars/token for English prose) that a ceiling
 * in chars catches the regression this is for.
 */

/**
 * Separator `instructions.ts` joins prompt sections with.
 *
 * Exported and imported there rather than written out twice: this module's
 * whole job is to measure what `instructions.ts` assembles, so a separator that
 * existed as a literal in one and a constant in the other could drift and the
 * budget would quietly stop describing the real prompt.
 */
const SECTION_SEPARATOR = "\n\n---\n\n";

/**
 * Ceiling for the always-on prompt alone.
 *
 * Measured 2026-08-10 at 24,338 chars (~6k tokens), down from 31,763 when
 * `How you're built`, `Group lore`, `Recurring concepts` and `Matthew Blode`
 * moved into load-on-demand skills. 28,000 leaves ~15% headroom, which is a few
 * more rules but not another section.
 *
 * The right move when this fails is usually a skill, not a bigger number: eve's
 * guidance is to keep instructions short and stable and put procedures behind
 * `load_skill`. Raising it is still a fine thing to do — deliberately, in a
 * commit that says why, having read what's already in there.
 */
export const BASE_INSTRUCTIONS_BUDGET_CHARS = 28_000;

/**
 * Ceiling for the rendered `<group_memory>` block.
 *
 * There is no production baseline to quote here: the block lives in Vercel Blob
 * per group JID and this module is pure, so the number is a policy rather than
 * a measurement. 7,000 rendered chars is ~1,300 of prose per category across
 * the five in `memory-categories.ts` (the fence and headings cost a fixed 433
 * chars on top), which is a couple of paragraphs each: comfortably
 * more than a useful standing-facts block needs, and far less than a nightly
 * append loop would reach if it ever stopped consolidating and started
 * accumulating. Enforce it against real memory with `assembledPromptChars`.
 */
export const MEMORY_BLOCK_BUDGET_CHARS = 7000;

/**
 * Ceiling for a single category, enforced at the write in
 * `agent/tools/save-memory.ts`.
 *
 * Derived rather than picked so the two can't drift: if every category sits at
 * this cap the rendered block lands on `MEMORY_BLOCK_BUDGET_CHARS`, with the
 * 500 taken off first covering the fence and headings. That is the same sum the
 * paragraph above states in prose, now stated once in code.
 *
 * Without it the budget was advisory: nothing stopped a save writing an
 * arbitrarily long block, and the ceiling was only ever checked by a test
 * against a synthetic record.
 */
export const MEMORY_CATEGORY_BUDGET_CHARS = Math.floor(
  (MEMORY_BLOCK_BUDGET_CHARS - 500) / MEMORY_CATEGORIES.length,
);

/** Ceiling for everything the model sees as system prompt. */
export const PROMPT_BUDGET_CHARS = BASE_INSTRUCTIONS_BUDGET_CHARS + MEMORY_BLOCK_BUDGET_CHARS;

/**
 * Size of the rendered memory block for a stored memory record, including the
 * fence and per-category headings. `null` (backend unreachable) renders
 * nothing, exactly as `instructions.ts` treats it.
 */
export const memoryBlockChars = (memory: Record<string, string> | null): number =>
  buildGroupMemoryPrompt(memory ?? {}).length;

/**
 * Total chars of the system prompt the Bot would run with, given this chat's
 * stored memory and the size of its always-on instructions. The instructions
 * are a runtime file on the volume since 2026-09-06 (hello.expert edits them),
 * so their size is an argument here and is measured where they are written.
 */
export const assembledPromptChars = (
  memory: Record<string, string> | null,
  baseChars: number,
): number => {
  const block = memoryBlockChars(memory);
  if (block === 0) {
    return baseChars;
  }
  return baseChars + SECTION_SEPARATOR.length + block;
};
