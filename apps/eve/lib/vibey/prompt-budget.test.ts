import { describe, expect, it } from "vitest";

import { MEMORY_CATEGORIES } from "./memory-categories.js";
import {
  assembledPromptChars,
  BASE_INSTRUCTIONS_BUDGET_CHARS,
  MEMORY_BLOCK_BUDGET_CHARS,
  memoryBlockChars,
  PROMPT_BUDGET_CHARS,
} from "./prompt-budget.js";

/** A memory record with `chars` of prose in every category. */
const memoryOfSize = (chars: number): Record<string, string> =>
  Object.fromEntries(MEMORY_CATEGORIES.map((c) => [c, "x".repeat(chars)]));

const OVER_BUDGET = [
  "The system prompt is over budget.",
  "Every turn pays for this, and a prompt the model stops reading carefully is a",
  "quiet failure: replies get worse, nothing errors.",
  "",
  "Either trim it, or raise the ceiling in agent/lib/prompt-budget.ts on purpose",
  "and say why in the commit. Don't raise it reflexively to get green.",
].join("\n");

// The always-on instructions are a runtime file on the volume, so the budget
// is applied at the largest size that file may reach rather than to a constant.
const BASE = BASE_INSTRUCTIONS_BUDGET_CHARS;

describe("prompt budget", () => {
  it("keeps the assembled prompt under budget with a full memory block", () => {
    // The largest memory the block budget allows, so this fails when the base
    // prompt grows into the headroom memory is meant to have.
    const memory = memoryOfSize(
      Math.floor((MEMORY_BLOCK_BUDGET_CHARS - 500) / MEMORY_CATEGORIES.length),
    );
    const total = assembledPromptChars(memory, BASE);
    expect(memoryBlockChars(memory)).toBeLessThanOrEqual(MEMORY_BLOCK_BUDGET_CHARS);
    expect(
      total,
      `${OVER_BUDGET}\n\nAssembled prompt is ${total} chars, budget is ${PROMPT_BUDGET_CHARS}.`,
    ).toBeLessThanOrEqual(PROMPT_BUDGET_CHARS);
  });

  it("fails a memory block that has outgrown its budget", () => {
    // The guard has teeth: an unbounded nightly append eventually looks like
    // this, and the assertion above has to go red when it does.
    const runaway = memoryOfSize(MEMORY_BLOCK_BUDGET_CHARS);
    expect(memoryBlockChars(runaway)).toBeGreaterThan(MEMORY_BLOCK_BUDGET_CHARS);
    expect(assembledPromptChars(runaway, BASE)).toBeGreaterThan(PROMPT_BUDGET_CHARS);
  });

  it("mirrors instructions/memory.ts: no memory means no block and no separator", () => {
    expect(assembledPromptChars(null, BASE)).toBe(BASE);
    expect(assembledPromptChars({}, BASE)).toBe(BASE);
    expect(assembledPromptChars({ lore: "   " }, BASE)).toBe(BASE);
  });

  it("counts the fence and headings, not just the stored prose", () => {
    const memory = { lore: "y".repeat(100) };
    expect(memoryBlockChars(memory)).toBeGreaterThan(100);
    expect(assembledPromptChars(memory, BASE)).toBeGreaterThan(BASE + 100);
  });
});
