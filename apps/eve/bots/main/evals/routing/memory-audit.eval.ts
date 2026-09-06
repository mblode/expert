import { defineEval } from "eve/evals";

export default defineEval({
  description: "A memory-health ask routes to audit-memory, not a guess.",
  async test(t) {
    await t.send("@vibey how's our group memory looking? anything stale or out of date?");
    t.calledTool("audit-memory");
  },
});
